Unicode true
RequestExecutionLevel user
SilentInstall silent
Name "Night Cruising installer path regression"
OutFile "${OUT_EXE}"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!define APP_EXECUTABLE_FILENAME "DeepSeek Harness.exe"
!define APP_64_UNPACKED_SIZE 1
!define INSTALL_REGISTRY_KEY "Software\NightCruisingPathTest${FIXTURE_ID}"
LangString INSTALLER_PATH_INVALID 1033 "invalid"
LangString INSTALLER_PATH_OWNERSHIP 1033 "occupied"
LangString INSTALLER_DISK_SPACE 1033 "disk space"
!include "${PATH_NSH}"

Var report
!macro check LABEL TARGET
    StrCpy $InstallerPath "${TARGET}"
    Call InstallerPreflight
    FileWriteUTF16LE $report "[${LABEL}]$InstallerError$\r$\n"
!macroend
Section
    FileOpen $report "$EXEDIR\results.txt" w
    !insertmacro check "direct" "$EXEDIR\dirs-only\app"
    !insertmacro check "nested" "$EXEDIR\dirs-only\新目录\sub\app"
    !insertmacro check "empty" "$EXEDIR\empty"
    !insertmacro check "occupied" "$EXEDIR\occupied"
    !insertmacro check "denied" "$EXEDIR\denied\app"
    !insertmacro check "system" "$WINDIR\night-cruising-test"
    FileClose $report
SectionEnd
