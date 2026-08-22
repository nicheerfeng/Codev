; "Open in Codev" shell verbs for folders, folder backgrounds, and drives.
; HKCU matches installer currentUser scope. %V = clicked path.
; NoWorkingDirectory keeps Explorer from overriding %V (System32 on Drive).

!macro NSIS_HOOK_POSTINSTALL
  ; Remove the legacy verb from installations created before the Codev rebrand.
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OpenInTerax"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OpenInTerax"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\OpenInTerax"

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
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OpenInCodev"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OpenInCodev"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\OpenInCodev"
  DeleteRegKey HKCU "Software\Classes\Directory\shell\OpenInTerax"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\OpenInTerax"
  DeleteRegKey HKCU "Software\Classes\Drive\shell\OpenInTerax"
!macroend
