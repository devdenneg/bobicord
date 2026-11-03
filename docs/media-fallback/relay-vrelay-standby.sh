#!/bin/bash
# RelayApp: основной медиа-хост на подхвате у резервного.
# Пока резервный хост жив, vrelay здесь остановлен: два агента сразу дерево не различает,
# главным становится тот, кто подключился первым. Если резервный пропал (его выключили),
# а прод отвечает, после NEED проверок подряд (~1,5 мин) поднимаем свой vrelay.
# Обратно сам не гасит. Отключить: systemctl disable --now relay-vrelay-standby.timer
set -u
FALLBACK_HOST=138.16.160.122
FALLBACK_PORT=3478          # coturn резервного, TCP
PROD_URL=https://reelay.online/
NEED=3
STATE=/run/relay-vrelay-standby.fails
CONTAINER=vrelay-vrelay-1

running=$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null || echo false)
if [ "$running" = "true" ]; then rm -f "$STATE"; exit 0; fi

if timeout 5 bash -c "exec 3<>/dev/tcp/$FALLBACK_HOST/$FALLBACK_PORT" 2>/dev/null; then
  rm -f "$STATE"; exit 0
fi

code=$(curl -s -m 8 -o /dev/null -w '%{http_code}' "$PROD_URL" || true)
if [ "$code" != "200" ]; then
  echo "резерв $FALLBACK_HOST не отвечает, но и прод тоже ($code): похоже, сеть этого хоста, жду"
  exit 0
fi

n=$(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$STATE"
echo "резерв $FALLBACK_HOST не отвечает ($n/$NEED)"
[ "$n" -ge "$NEED" ] || exit 0

echo "резерв выключен: поднимаю свой vrelay"
docker start "$CONTAINER" || (cd /opt/vrelay && docker compose up -d vrelay)
rm -f "$STATE"
