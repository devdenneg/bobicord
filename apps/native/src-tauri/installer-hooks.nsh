; NSIS hooks (Tauri v2).
; exe и путь остаются RelayApp (updater матчит по имени — не ломаем цепочку обновлений),
; ярлыки показываем под брендом «Рилэй». Иконку ярлыка берём из ОТДЕЛЬНОГО icon.ico
; (ресурс в папке установки) — это НОВЫЙ путь, мимо залипшего кэша иконок Explorer,
; который держит генерик по ключу exe-иконки. Плюс форс-рефреш кэша (SHChangeNotify + ie4uinit).
!macro NSIS_HOOK_POSTINSTALL
  Delete "$DESKTOP\RelayApp.lnk"
  Delete "$SMPROGRAMS\RelayApp.lnk"
  Delete "$DESKTOP\РИЛЭЙ.lnk"
  Delete "$SMPROGRAMS\РИЛЭЙ.lnk"
  Push $0
  StrCpy $0 "$INSTDIR\RelayApp.exe"
  IfFileExists "$INSTDIR\icons\icon.ico" 0 +2
    StrCpy $0 "$INSTDIR\icons\icon.ico"
  IfFileExists "$INSTDIR\resources\icons\icon.ico" 0 +2
    StrCpy $0 "$INSTDIR\resources\icons\icon.ico"
  CreateShortcut "$DESKTOP\Рилэй.lnk" "$INSTDIR\RelayApp.exe" "" "$0" 0
  CreateShortcut "$SMPROGRAMS\Рилэй.lnk" "$INSTDIR\RelayApp.exe" "" "$0" 0
  Pop $0
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
  nsExec::Exec '"$SYSDIR\ie4uinit.exe" -show'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Delete "$DESKTOP\Рилэй.lnk"
  Delete "$SMPROGRAMS\Рилэй.lnk"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
  nsExec::Exec '"$SYSDIR\ie4uinit.exe" -show'
!macroend