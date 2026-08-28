; "Open in Codev" shell verbs for folders, folder backgrounds, and drives.
; HKCU matches installer currentUser scope. %V = clicked path.
; NoWorkingDirectory keeps Explorer from overriding %V (System32 on Drive).

!macro NSIS_HOOK_POSTINSTALL
  ; Recreate the current verbs so Explorer drops a cached icon value.
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OpenInCodev"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OpenInCodev"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\OpenInCodev"

  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInCodev" "" "Open in Codev"
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInCodev" "Icon" '"$INSTDIR\codev.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInCodev" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInCodev\command" "" '"$INSTDIR\codev.exe" "%V"'

  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInCodev" "" "Open in Codev"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInCodev" "Icon" '"$INSTDIR\codev.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInCodev" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInCodev\command" "" '"$INSTDIR\codev.exe" "%V"'

  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInCodev" "" "Open in Codev"
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInCodev" "Icon" '"$INSTDIR\codev.exe",0'
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInCodev" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInCodev\command" "" '"$INSTDIR\codev.exe" "%V"'

  ; Refresh file associations and Explorer's icon cache immediately.
  !insertmacro UPDATEFILEASSOC

  ; Refresh only existing shortcuts so an opted-out shortcut is never created
  ; implicitly.
  IfFileExists "$DESKTOP\Codev.lnk" codev_refresh_desktop_icon codev_desktop_icon_done
codev_refresh_desktop_icon:
  Delete "$DESKTOP\Codev.lnk"
  CreateShortcut "$DESKTOP\Codev.lnk" "$INSTDIR\codev.exe" "" "$INSTDIR\codev.exe" 0
  !insertmacro SetLnkAppUserModelId "$DESKTOP\Codev.lnk"
codev_desktop_icon_done:
  IfFileExists "$SMPROGRAMS\Codev.lnk" codev_refresh_start_menu_icon codev_start_menu_icon_done
codev_refresh_start_menu_icon:
  Delete "$SMPROGRAMS\Codev.lnk"
  CreateShortcut "$SMPROGRAMS\Codev.lnk" "$INSTDIR\codev.exe" "" "$INSTDIR\codev.exe" 0
  !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\Codev.lnk"
codev_start_menu_icon_done:
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OpenInCodev"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OpenInCodev"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\OpenInCodev"
  !insertmacro UPDATEFILEASSOC
!macroend
