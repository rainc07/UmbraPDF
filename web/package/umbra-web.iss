; Windows installer for the desktop web app. Per-user install, no admin prompt, Start menu + optional desktop shortcut,
; uninstaller. Packs the folder made by build.mjs. Built by CI (.github/workflows/web-app.yml):
;   iscc /DAppVersion=1.2.0 /DSrc=..\release\UmbraPDF-Web-win-x64 /O..\release umbra-web.iss

#ifndef AppVersion
  #define AppVersion "0.0.0-dev"
#endif
#ifndef Src
  #define Src "..\release\UmbraPDF-Web-win-x64"
#endif

[Setup]
AppId={{6F1D3C52-8B7A-4E0F-9C21-5A4B7D0E9F13}
AppName=Umbra PDF
AppVersion={#AppVersion}
AppVerName=Umbra PDF {#AppVersion} (desktop)
AppPublisher=Umbra PDF
AppPublisherURL=https://github.com/rainc07/UmbraPDF
DefaultDirName={autopf}\Umbra PDF
DefaultGroupName=Umbra PDF
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
LicenseFile={#Src}\LICENSE
SetupIconFile=umbra.ico
UninstallDisplayIcon={app}\umbra.ico
OutputBaseFilename=UmbraPDF-{#AppVersion}-Windows-Setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; Stops a running Umbra PDF (its node.exe) before files are replaced or removed.
CloseApplications=force

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#Src}\*"; DestDir: "{app}"; Excludes: "settings.json"; Flags: recursesubdirs ignoreversion
; Keep the user's settings on upgrade.
Source: "{#Src}\settings.json"; DestDir: "{app}"; Flags: onlyifdoesntexist

[Icons]
Name: "{group}\Umbra PDF"; Filename: "{app}\Umbra PDF.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\umbra.ico"; Comment: "Redact PDFs on this computer"
Name: "{group}\Umbra PDF settings"; Filename: "{sys}\notepad.exe"; Parameters: """{app}\settings.json"""; WorkingDir: "{app}"
Name: "{autodesktop}\Umbra PDF"; Filename: "{app}\Umbra PDF.cmd"; WorkingDir: "{app}"; IconFilename: "{app}\umbra.ico"; Tasks: desktopicon

[Run]
Filename: "{app}\Umbra PDF.cmd"; WorkingDir: "{app}"; Description: "{cm:LaunchProgram,Umbra PDF}"; Flags: postinstall nowait skipifsilent shellexec
