; BicuSlicer for Windows: the installer (Inno Setup 6). Built by windows\build.ps1, which passes the version and the
; folder it made. Installs for the current user (no administrator rights needed) into %LOCALAPPDATA%\Programs\BicuSlicer;
; your data stays in %LOCALAPPDATA%\BicuSlicer\data, and uninstalling leaves it there.

#ifndef AppVersion
  #define AppVersion "0.0.0-dev"
#endif
#ifndef SourceDir
  #define SourceDir "..\build\BicuSlicer"
#endif

[Setup]
AppId={{5852D647-8CBB-4304-B3F5-B71B408E9516}
AppName=BicuSlicer
AppVersion={#AppVersion}
AppPublisher=BicuSlicer
AppPublisherURL=https://github.com/kylefutter97-prog/BicuSlicer
DefaultDirName={localappdata}\Programs\BicuSlicer
DefaultGroupName=BicuSlicer
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputBaseFilename=BicuSlicer-Setup-{#AppVersion}
SetupIconFile={#SourceDir}\icon.ico
UninstallDisplayIcon={app}\icon.ico
LicenseFile={#SourceDir}\LICENSE.txt
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=yes

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: recursesubdirs ignoreversion

[Icons]
Name: "{group}\BicuSlicer"; Filename: "{app}\python\pythonw.exe"; Parameters: """{app}\launcher.pyw"""; WorkingDir: "{app}"; IconFilename: "{app}\icon.ico"
Name: "{group}\BicuSlicer data folder"; Filename: "{localappdata}\BicuSlicer\data"
Name: "{autodesktop}\BicuSlicer"; Filename: "{app}\python\pythonw.exe"; Parameters: """{app}\launcher.pyw"""; WorkingDir: "{app}"; IconFilename: "{app}\icon.ico"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; Flags: unchecked

[Run]
Filename: "{app}\python\pythonw.exe"; Parameters: """{app}\launcher.pyw"""; WorkingDir: "{app}"; Description: "Start BicuSlicer now"; Flags: postinstall nowait skipifsilent

[UninstallRun]
; stop a running BicuSlicer: only the Python processes that run from this install folder
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -Command ""Get-Process python,pythonw -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -like '{app}\*' }} | Stop-Process -Force"""; Flags: runhidden; RunOnceId: "StopBicuSlicer"

[Registry]
; "Start with Windows" (set from the tray) is removed on uninstall
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueName: "BicuSlicer"; Flags: uninsdeletevalue dontcreatekey
