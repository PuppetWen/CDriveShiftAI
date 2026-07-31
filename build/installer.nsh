!macro customUnInstall
  ${IfNot} ${isUpdated}
    ${IfNot} ${Silent}
      IfFileExists "$INSTDIR\CDriveShiftAI.exe" 0 restore_prompt_done
      ExecWait '"$INSTDIR\CDriveShiftAI.exe" --uninstall-restore'
      restore_prompt_done:
    ${EndIf}
  ${EndIf}
!macroend
