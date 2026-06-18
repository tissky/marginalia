@echo off
setlocal

rem CLI entry point for Windows desktop packages. It runs the Python package
rem embedded in the Tauri resources, so users do not need system Python.

if "%MARGINALIA_HOME%"=="" set "MARGINALIA_HOME=%USERPROFILE%\Marginalia"

set "SCRIPT_DIR=%~dp0"
set "BACKEND="

if not "%MARGINALIA_BUNDLED_BACKEND%"=="" (
  if exist "%MARGINALIA_BUNDLED_BACKEND%\." set "BACKEND=%MARGINALIA_BUNDLED_BACKEND%"
)

if "%BACKEND%"=="" (
  if exist "%SCRIPT_DIR%resources\backend\." set "BACKEND=%SCRIPT_DIR%resources\backend"
)

if "%BACKEND%"=="" (
  if exist "%SCRIPT_DIR%..\..\backend\." set "BACKEND=%SCRIPT_DIR%..\..\backend"
)

if "%BACKEND%"=="" (
  echo marginalia: cannot find bundled backend runtime 1>&2
  exit /b 127
)

set "PYTHON="
if exist "%BACKEND%\python.exe" set "PYTHON=%BACKEND%\python.exe"
if "%PYTHON%"=="" if exist "%BACKEND%\Scripts\python.exe" set "PYTHON=%BACKEND%\Scripts\python.exe"

if "%PYTHON%"=="" (
  echo marginalia: cannot find bundled Python under %BACKEND% 1>&2
  exit /b 127
)

if "%PYTHONHOME%"=="" if exist "%BACKEND%\python.exe" set "PYTHONHOME=%BACKEND%"
if "%PYTHONUNBUFFERED%"=="" set "PYTHONUNBUFFERED=1"

if "%MARGINALIA_PY_MODULE%"=="" set "MARGINALIA_PY_MODULE=marginalia.cli.repl"

"%PYTHON%" -m "%MARGINALIA_PY_MODULE%" %*
exit /b %ERRORLEVEL%
