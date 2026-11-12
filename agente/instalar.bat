@echo off
rem Instala el Agente Sisgen como servicio de Windows (ejecutar como Administrador).
setlocal
net session >nul 2>&1
if errorlevel 1 (
  echo Ejecuta este archivo como Administrador ^(clic derecho -^> Ejecutar como administrador^).
  pause
  exit /b 1
)
if not exist "%~dp0agente.ini" (
  echo Falta agente.ini. Copia agente.ini.ejemplo como agente.ini y completa portal, llave y sisgen.
  pause
  exit /b 1
)
echo Probando la configuracion...
"%~dp0SisgenAgente.exe" --una-vez
if errorlevel 1 (
  echo.
  echo La prueba fallo: revisa los mensajes de arriba y agente.ini.
  pause
  exit /b 1
)
sc query SisgenAgente >nul 2>&1 && (
  sc stop SisgenAgente >nul 2>&1
  timeout /t 3 /nobreak >nul
  sc delete SisgenAgente >nul
  timeout /t 2 /nobreak >nul
)
sc create SisgenAgente binPath= "\"%~dp0SisgenAgente.exe\"" start= delayed-auto DisplayName= "Agente Sisgen (Portal)" >nul
sc description SisgenAgente "Envia al Portal Sisgen los documentos emitidos y su estado de envio al SII." >nul
rem Si falla, Windows lo reinicia a los 60 segundos
sc failure SisgenAgente reset= 86400 actions= restart/60000/restart/60000/restart/60000 >nul
sc start SisgenAgente
echo.
echo Agente instalado. Registros en: %~dp0logs
pause
