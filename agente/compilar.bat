@echo off
rem Compila el Agente Sisgen y su instalador con el compilador C# que trae Windows (.NET Framework 4).
rem No requiere instalar nada.
setlocal
set CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe
if not exist "%CSC%" (
  echo No se encontro .NET Framework 4 en este equipo.
  exit /b 1
)
if not exist "%~dp0dist" mkdir "%~dp0dist"

rem 1) El servicio
"%CSC%" /nologo /target:exe /platform:anycpu /optimize+ /out:"%~dp0dist\SisgenAgente.exe" ^
  /reference:System.ServiceProcess.dll /reference:System.Core.dll /reference:System.Security.dll /reference:System.Xml.dll ^
  "%~dp0src\*.cs"
if errorlevel 1 exit /b 1

rem 2) El instalador (un solo archivo que lleva el servicio adentro)
"%CSC%" /nologo /target:winexe /platform:anycpu /optimize+ /main:SisgenAgente.Instalador ^
  /out:"%~dp0dist\InstalarAgenteSisgen.exe" /win32manifest:"%~dp0instalador\app.manifest" ^
  /resource:"%~dp0dist\SisgenAgente.exe",SisgenAgente.exe ^
  /resource:"%~dp0..\client\public\logo-sisgen.png",logo.png ^
  /reference:System.ServiceProcess.dll /reference:System.Core.dll /reference:System.Windows.Forms.dll /reference:System.Drawing.dll ^
  "%~dp0src\*.cs" "%~dp0instalador\*.cs"
if errorlevel 1 exit /b 1

copy /y "%~dp0agente.ini.ejemplo" "%~dp0dist\" >nul
copy /y "%~dp0instalar.bat" "%~dp0dist\" >nul
copy /y "%~dp0desinstalar.bat" "%~dp0dist\" >nul
copy /y "%~dp0LEEME.txt" "%~dp0dist\" >nul
echo Listo: %~dp0dist\InstalarAgenteSisgen.exe
