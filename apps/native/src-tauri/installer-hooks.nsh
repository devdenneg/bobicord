; NSIS hooks (Tauri v2).
; exe и путь остаются RelayApp (updater матчит по имени — не ломаем цепочку обновлений),
; но ЯРЛЫКИ на рабочем столе / в меню Пуск показываем под брендом «Рилэй» и обновляем
; иконку на уже существующих ярлыках (SHChangeNotify сбрасывает кэш иконок Explorer).
; Хук выполняется на КАЖДОМ установе/обновлении, поэтому старое имя/иконка чинятся сами.
!macro NSIS_HOOK_POSTINSTALL
  Delete "$DESKTOP\RelayApp.lnk"
  Delete "$SMPROGRAMS\RelayApp.lnk"
  Delete "$DESKTOP\РИЛЭЙ.lnk"
  Delete "$SMPROGRAMS\РИЛЭЙ.lnk"
  CreateShortcut "$DESKTOP\Рилэй.lnk" "$INSTDIR\RelayApp.exe"
  CreateShortcut "$SMPROGRAMS\Рилэй.lnk" "$INSTDIR\RelayApp.exe"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Delete "$DESKTOP\Рилэй.lnk"
  Delete "$SMPROGRAMS\Рилэй.lnk"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend