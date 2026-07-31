!macro customUnInstall
  ${IfNot} ${isUpdated}
    ${IfNot} ${Silent}
      IfFileExists "$INSTDIR\CDriveShiftAI.exe" 0 restore_prompt_done
      ExecWait '"$INSTDIR\CDriveShiftAI.exe" --uninstall-restore'
      restore_prompt_done:
    ${EndIf}
  ${EndIf}
!macroend

; CDriveShiftAI deliberately keeps its indexes, settings and migration journal
; beside the application instead of placing them on C:. electron-builder's
; default updater removes the complete old $INSTDIR, so preserve that one data
; directory outside $INSTDIR while the old application files are replaced.
!macro customRemoveFiles
  StrCpy $R8 "$INSTDIR.cdriveshiftai-data-preserved"
  IfFileExists "$R8\*.*" 0 preserve_data
    Abort "A previous CDriveShiftAI data-preservation directory still exists: $R8"

  preserve_data:
  IfFileExists "$INSTDIR\.cdriveshiftai-data\*.*" 0 remove_application
    ClearErrors
    Rename "$INSTDIR\.cdriveshiftai-data" "$R8"
    IfErrors 0 remove_application
      Abort "CDriveShiftAI could not preserve .cdriveshiftai-data before updating."

  remove_application:
  SetOutPath "$TEMP"
  RMDir /r "$INSTDIR"

  IfFileExists "$R8\*.*" 0 remove_files_done
    CreateDirectory "$INSTDIR"
    ClearErrors
    Rename "$R8" "$INSTDIR\.cdriveshiftai-data"
    IfErrors 0 remove_files_done
      Abort "CDriveShiftAI could not restore .cdriveshiftai-data after updating."

  remove_files_done:
!macroend
