!macro NSIS_HOOK_POSTINSTALL
  CopyFiles /SILENT "$INSTDIR\resources\package\windows\marginalia.cmd" "$INSTDIR\marginalia.cmd"
  CopyFiles /SILENT "$INSTDIR\resources\package\windows\marginalia-mcp.cmd" "$INSTDIR\marginalia-mcp.cmd"
  CopyFiles /SILENT "$INSTDIR\resources\package\windows\marginalia-worker.cmd" "$INSTDIR\marginalia-worker.cmd"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$INSTDIR\marginalia.cmd"
  Delete "$INSTDIR\marginalia-mcp.cmd"
  Delete "$INSTDIR\marginalia-worker.cmd"
!macroend
