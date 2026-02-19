<div align="center">
  <img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/drive/10Sg5h0GT6rEQzT_yWFpi_vAmVdH2rzjm

## Run Locally

**Prerequisites:**  Node.js

1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Windows에서 한글 깨짐 대응

Windows 환경에서 한글이 깨지는 문제가 반복된다면 아래를 꼭 확인하세요.

1. PowerShell UTF-8 코드페이지 설정
   - `chcp 65001`
2. 프로젝트 저장 규칙 적용
   - `.editorconfig`와 `.gitattributes`에서 UTF-8 및 LF 정책을 강제합니다.
3. VS Code 설정 고정
   - `.vscode/settings.json`의 `files.encoding`을 `utf8`로 고정
   - `files.autoGuessEncoding`은 `false`로 설정

## UTF-8 점검

- `npm run check:encoding` 실행 시 저장소 내 깨진 문자(replacement character)를 탐지합니다.
- Git 정책(선택)
  - 팀 공유 환경에서는 `git config core.autocrlf false` 또는 `input`을 권장하고,
    `.gitattributes`를 함께 사용하세요.

