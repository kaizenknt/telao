; Instalador do Telão (NSIS). Monta direto no Linux, sem Wine:
;   makensis -DVERSION=1.7.0 -DSRC=dist/win-unpacked -DOUT=dist/Telao-Setup-1.7.0.exe scripts/installer.nsi
; Instala só para o usuário (não pede administrador), em %LocalAppData%\Programs\Telao.
; As configurações ficam em %AppData%\Telao e são mantidas ao atualizar ou desinstalar.
Unicode true
SetCompressor /SOLID lzma
SetCompressorDictSize 64
RequestExecutionLevel user
ManifestDPIAware true

!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!define APPNAME "Telão"
!define EXE "Telao.exe"
!define UNKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Telao"

Name "${APPNAME}"
Caption "Instalando o ${APPNAME}"
OutFile "${OUT}"
InstallDir "$LOCALAPPDATA\Programs\Telao"
Icon "${ICON}"
UninstallIcon "${ICON}"
BrandingText "Telão ${VERSION}"
ShowInstDetails nevershow
ShowUninstDetails nevershow
AutoCloseWindow true
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APPNAME}"
VIAddVersionKey "FileDescription" "Instalador do ${APPNAME}"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Telão"

Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

!macro FECHAR_TELAO
  ; fecha o Telão (e o servidor/motor que ele abriu) antes de trocar os arquivos
  nsExec::Exec 'taskkill /F /T /IM "${EXE}"'
  nsExec::Exec 'taskkill /F /IM "mediamtx.exe"'
  nsExec::Exec 'taskkill /F /IM "gst-launch-1.0.exe"'
  Sleep 800
!macroend

Section "Telão"
  !insertmacro FECHAR_TELAO
  SetOutPath "$INSTDIR"
  ; troca a versão anterior inteira (sem sobras de arquivos antigos)
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"
  File /r "${SRC}/*.*"

  ; atalhos
  CreateShortCut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\${EXE}" 0
  CreateShortCut "$SMPROGRAMS\${APPNAME}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\${EXE}" 0

  ; links de convite (telao://entrar/...) abrem este Telão
  WriteRegStr HKCU "Software\Classes\telao" "" "URL:Convite do Telão"
  WriteRegStr HKCU "Software\Classes\telao" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\telao\DefaultIcon" "" '"$INSTDIR\${EXE}",0'
  WriteRegStr HKCU "Software\Classes\telao\shell\open\command" "" '"$INSTDIR\${EXE}" "%1"'

  ; aparece em "Adicionar ou remover programas"
  WriteUninstaller "$INSTDIR\Desinstalar Telão.exe"
  WriteRegStr HKCU "${UNKEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "${UNKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNKEY}" "Publisher" "Telão"
  WriteRegStr HKCU "${UNKEY}" "DisplayIcon" '"$INSTDIR\${EXE}",0'
  WriteRegStr HKCU "${UNKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNKEY}" "UninstallString" '"$INSTDIR\Desinstalar Telão.exe"'
  WriteRegDWORD HKCU "${UNKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNKEY}" "NoRepair" 1

  ; abre o Telão no fim
  Exec '"$INSTDIR\${EXE}"'
SectionEnd

Section "Uninstall"
  !insertmacro FECHAR_TELAO
  Delete "$DESKTOP\${APPNAME}.lnk"
  Delete "$SMPROGRAMS\${APPNAME}.lnk"
  DeleteRegKey HKCU "Software\Classes\telao"
  DeleteRegKey HKCU "${UNKEY}"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Telao"
  RMDir /r "$INSTDIR"
SectionEnd
