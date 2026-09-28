@echo off
setlocal enabledelayedexpansion

echo ========================================================
echo Standalone Attendance Agent Build Script (PyInstaller)
echo ========================================================

echo.
echo [1/3] Checking and installing dependencies...
python -m pip install requests pywinctl pyinstaller

if %ERRORLEVEL% NEQ 0 (
    echo [ERROR] Failed to install required Python dependencies.
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo [2/3] Compiling wfh_agent.py into standalone executable...
pyinstaller --onefile --noconsole --name "attendance_agent" --clean wfh_agent.py

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [ERROR] PyInstaller compilation failed! Check the log above.
    pause
    exit /b %ERRORLEVEL%
)

echo.
echo [3/3] Preparing standalone distribution package in dist\...
if exist agent_config.json.example (
    copy /Y agent_config.json.example dist\agent_config.json.example >nul
)
if exist agent_config.json (
    copy /Y agent_config.json dist\agent_config.json >nul
) else if exist agent_config.json.example (
    copy /Y agent_config.json.example dist\agent_config.json >nul
)
if exist .env (
    copy /Y .env dist\.env >nul
)

echo.
echo ========================================================
echo Standalone Executable Successfully Built!
echo Output: dist\attendance_agent.exe
echo.
echo Standalone Zero-Effort Deployment Instructions:
echo  1. Copy 'dist\attendance_agent.exe' and 'dist\agent_config.json'
echo     to any folder on the employee's PC (e.g., C:\Program Files\AttendanceAgent).
echo  2. Edit 'agent_config.json' to populate:
echo       "employee_id": "<employee_uuid>",
echo       "hostname": "<laptop_hostname>"
echo  3. Launch 'attendance_agent.exe' or add to Windows Startup:
echo     - Runs silently in the background with zero popups or prompts.
echo     - Logs activity to 'agent.log' in the same folder.
echo     - Requires NO Python installation on the target machine!
echo ========================================================
pause
