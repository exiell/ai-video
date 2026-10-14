@echo off
REM ===========================================================================
REM  AniGuide one-click launcher (Windows) -- just double-click this file
REM ===========================================================================
REM  This file deliberately contains **ASCII only**. Do not add non-ASCII text.
REM
REM  Why: cmd.exe parses .cmd files byte-by-byte using the system code page.
REM  On a Chinese Windows that is 936 (GBK). If this file were saved as UTF-8,
REM  the multibyte characters would be misread and the resulting garbage bytes
REM  break parsing of later lines -- showing up as "a perfectly valid command
REM  reports a syntax error". That is extremely hard to diagnose because it
REM  only happens on some locales.
REM
REM  So: this file only locates PowerShell and hands over.
REM  The real logic lives in scripts\start.ps1 (which reads UTF-8 correctly).
REM
REM  You can also run it directly from a terminal:
REM    powershell -ExecutionPolicy Bypass -File scripts\start.ps1
REM ===========================================================================

setlocal
cd /d "%~dp0"

REM Prefer PowerShell 7+ (pwsh); fall back to the built-in Windows PowerShell
where pwsh >nul 2>&1
if %errorlevel%==0 (
    pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1"
    goto :done
)

where powershell >nul 2>&1
if %errorlevel%==0 (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start.ps1"
    goto :done
)

echo.
echo   [X] PowerShell not found on this system.
echo.
echo       Please run these two commands manually instead:
echo         pnpm install
echo         pnpm dev
echo.
pause
exit /b 1

:done
endlocal
