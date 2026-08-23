; "Open in Codev" shell verbs for folders, folder backgrounds, and drives.
; HKCU matches installer currentUser scope. %V = clicked path.
; NoWorkingDirectory keeps Explorer from overriding %V (System32 on Drive).

!macro NSIS_HOOK_POSTINSTALL
  ; Remove the legacy verb from installations created before the Codev rebrand.
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OpenInTerax"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OpenInTerax"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\OpenInTerax"

  ; Recreate the current verbs so Explorer drops a cached icon value from an
  ; older build before reading the icon embedded in the new executable.
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OpenInCodev"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OpenInCodev"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\OpenInCodev"

  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInCodev" "" "Open in Codev"
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInCodev" "Icon" '"$INSTDIR\terax.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInCodev" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Directory\shell\OpenInCodev\command" "" '"$INSTDIR\terax.exe" "%V"'

  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInCodev" "" "Open in Codev"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInCodev" "Icon" '"$INSTDIR\terax.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInCodev" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\OpenInCodev\command" "" '"$INSTDIR\terax.exe" "%V"'

  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInCodev" "" "Open in Codev"
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInCodev" "Icon" '"$INSTDIR\terax.exe",0'
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInCodev" "NoWorkingDirectory" ""
  WriteRegStr HKCU "Software\Classes\Drive\shell\OpenInCodev\command" "" '"$INSTDIR\terax.exe" "%V"'

  ; Refresh file associations and Explorer's icon cache immediately.
  !insertmacro UPDATEFILEASSOC

  ; The built-in NSIS shortcut updater skips a .lnk when its target is already
  ; terax.exe, which preserves the old cached icon. Refresh only an existing
  ; desktop shortcut so an opted-out shortcut is never created implicitly.
  IfFileExists "$DESKTOP\Codev.lnk" codev_refresh_desktop_icon codev_desktop_icon_done
codev_refresh_desktop_icon:
  Delete "$DESKTOP\Codev.lnk"
  CreateShortcut "$DESKTOP\Codev.lnk" "$INSTDIR\terax.exe" "" "$INSTDIR\terax.exe" 0
  !insertmacro SetLnkAppUserModelId "$DESKTOP\Codev.lnk"
codev_desktop_icon_done:
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OpenInCodev"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OpenInCodev"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\OpenInCodev"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OpenInTerax"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OpenInTerax"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\OpenInTerax"
  !insertmacro UPDATEFILEASSOC
!macroend
