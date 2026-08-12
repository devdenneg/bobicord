// Какой сервер-чат РЕАЛЬНО виден на экране прямо сейчас. Отдельный крошечный модуль, потому что
// значение нужно и notify-WS (серверу — кому не слать web-push), и локальному гейту уведомлений
// (notify.ts), а импортировать notifyws из notify.ts нельзя — они уже связаны в обратную сторону.
//
// «Окно в фокусе» не равно «человек видит этот чат»: можно сидеть на главной или в другом сервере, и
// тогда карточку упоминания гасить нельзя — раньше именно так упоминание пропадало без следа.
let visible: string | null = null;

export function setVisibleChatServer(serverId: string | null): void { visible = serverId; }
export function visibleChatServer(): string | null { return visible; }
