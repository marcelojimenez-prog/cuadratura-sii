@echo off
rem Quita el servicio Agente Sisgen (ejecutar como Administrador). No borra archivos ni toca Sisgen.
sc stop SisgenAgente
timeout /t 3 /nobreak >nul
sc delete SisgenAgente
pause
