# Baaghi Scholor — Daily YouTube automation

This package builds the workflow you selected:
- Google Apps Script: daily trigger, Gemini topic/script generation, Google Sheet log, Pixabay search, GitHub dispatch.
- GitHub Actions: Urdu male narration, FFmpeg rendering, YouTube upload and thumbnail.
- YouTube Data API: automatic public upload.

## Before you begin

This is a complete automation **project**, but it will not work until you connect your own Google, Pixabay, GitHub and YouTube credentials and complete the one-time setup below.

It is free-tier based, not an unlimited-free guarantee:
- GitHub Free currently includes 2,000 Actions minutes/month for private repositories. A daily render may fit, but monitor actual duration and monthly usage; extra usage may be billed.
- Gemini free-tier limits and model access can change. Google says free-tier content may be used to improve its products, so do not send private or sensitive information.
- `edge-tts` uses Microsoft's online Edge speech endpoint through an unofficial community package. `ur-PK-AsadNeural` is listed by Microsoft as an Urdu (Pakistan) male voice, but this is not an SLA-backed production API and free/continuous commercial use is not guaranteed.
- One selected Pixabay video clip is looped beneath the entire narration. It does not create scene-by-scene footage. Review each clip's license and suitability.
- Islamic references and claims need human review. AI can make mistakes.
- Apps Script has a six-minute execution limit; it only orchestrates while GitHub renders the video.
- The original Make blueprint exposed a Pixabay API key. Revoke that old key and create/use a new one.

## A. Google Sheet and Apps Script

1. Create a new Google Sheet.
2. From that Sheet, open **Extensions → Apps Script**. This must be a spreadsheet-bound Apps Script project.
3. In the Apps Script editor, replace the contents of `Code.gs` with the `Code.gs` file from this ZIP.
4. Open **Project Settings** and set the time zone to `Asia/Karachi`.
5. In Project Settings, enable **Show "appsscript.json" manifest file in editor**. In the editor, open `appsscript.json` and replace it with the manifest file from this ZIP.
6. In `Code.gs`, find `saveConfig()` near the top and replace every placeholder:
   - `GEMINI_API_KEY`: create a key in Google AI Studio.
   - `PIXABAY_API_KEY`: create a NEW Pixabay API key.
   - `GITHUB_TOKEN`: create a fine-grained GitHub token. Give it access to your repository and **Contents: Read and write** permission.
   - `GITHUB_OWNER`: your GitHub username or organization.
   - `GITHUB_REPO`: the repository name (not its URL).
   - `WEBHOOK_SECRET`: create a long random secret (32+ characters).
7. Save the Apps Script project.
8. Select `saveConfig` in the function dropdown and click **Run** once. Approve the requested permissions.
9. Select `setup` and click **Run** once. This creates the `Videos` tab and stores the Sheet ID.

## B. GitHub repository

1. Create a **private** GitHub repository. Example name: `baaghi-scholor-automation`.
2. Upload/extract the contents of this ZIP into the repository's root. Keep the folder path `.github/workflows/daily.yml` exactly as it is.
3. Commit the files to the default branch.
4. Open **Settings → Secrets and variables → Actions → New repository secret**. Add:
   - `YOUTUBE_CLIENT_ID`
   - `YOUTUBE_CLIENT_SECRET`
   - `YOUTUBE_REFRESH_TOKEN`
   - `GAS_WEB_APP_URL`
   - `GAS_WEBHOOK_SECRET` (same exact value as `WEBHOOK_SECRET` in Apps Script).
5. Never put API keys, OAuth tokens or passwords in source files or Git commits.

## C. YouTube API and OAuth

1. Open Google Cloud Console and create/select a project.
2. In **APIs & Services → Library**, enable **YouTube Data API v3**.
3. Configure the OAuth consent screen. Choose the correct audience for your Google account and add your account as a test user while testing.
4. Important for ongoing daily automation: external OAuth apps left in **Testing** issue refresh tokens that expire after 7 days for scopes such as YouTube upload. Before creating the long-term token, move the app to **In production**. Google may show an unverified-app warning or require verification depending on the scope and project configuration. Follow the requirements shown in Cloud Console.
5. Under **Credentials**, create an OAuth Client ID of type **Web application**.
6. Add this exact Authorized redirect URI:
   `https://developers.google.com/oauthplayground`
7. Open https://developers.google.com/oauthplayground
8. Click the settings gear, enable **Use your own OAuth credentials**, and enter the Client ID and Client Secret.
9. In Step 1, enter this scope:
   `https://www.googleapis.com/auth/youtube.upload`
10. Click **Authorize APIs** and sign in with the Google account that owns/manages the YouTube channel.
11. Click **Exchange authorization code for tokens** in Step 2.
12. Copy the `refresh_token` from the response into GitHub secret `YOUTUBE_REFRESH_TOKEN`. Put the Client ID and Client Secret in their matching GitHub secrets.

Keep the refresh token private. If it is revoked or expires, generate a new one and update the GitHub secret.

## D. Deploy Apps Script Web App (status callback)

1. In Apps Script, click **Deploy → New deployment**.
2. Select **Web app**.
3. Set **Execute as: Me**.
4. Set **Who has access: Anyone**. The endpoint checks the long random secret in each POST.
5. Click **Deploy**, authorize if prompted, and copy the Web App URL ending in `/exec`.
6. In GitHub repository **Settings → Secrets and variables → Actions**, create/update:
   - `GAS_WEB_APP_URL` = the `/exec` URL
   - `GAS_WEBHOOK_SECRET` = the same secret used for `WEBHOOK_SECRET` in Apps Script.

The web app only receives job status and video URL callbacks.

## E. First test (do NOT make the first test public)

1. In the GitHub repository, open `render_upload.py`.
2. Find this line in `upload_video()`:
   `"privacyStatus": "public"`
3. Temporarily change `public` to `unlisted`, save and commit the change.
4. In Apps Script, select `testGenerateAndDispatch()` and click **Run**.
5. Open the GitHub repository's **Actions** tab. The `Render and publish Baaghi Scholor video` workflow should start.
6. Wait for the workflow to finish. Check the `Videos` sheet:
   - `PUBLISHED` with a YouTube URL means upload and callback succeeded.
   - `FAILED` means inspect the error in the last column and GitHub Actions logs.
7. Open the unlisted video and check voice pronunciation, script, footage, video length, title, description and thumbnail.
8. If everything is correct, change `privacyStatus` back to `public` in `render_upload.py` and commit the change.
9. Only now run `installDailyTrigger()` in Apps Script. It creates a daily trigger for approximately 10 AM Pakistan time. Google time triggers are approximate, not guaranteed to fire at the exact minute.

## F. What happens automatically each day

1. Apps Script asks Gemini 3.8 Flash for an Islamic topic, 8–10 minute Roman Urdu script, title, description, tags and English Pixabay search terms.
2. Gemini transliterates the Roman Urdu script into Urdu script for the Pakistani Urdu voice.
3. Apps Script writes the job to the `Videos` sheet and dispatches it to GitHub.
4. GitHub downloads one suitable Pixabay video, creates Urdu narration with `ur-PK-AsadNeural`, joins narration chunks, loops the video to match the narration, and renders a 1080p MP4 with FFmpeg.
5. It creates a thumbnail from a frame of the video with the title overlaid.
6. It uploads the video to YouTube and attaches the thumbnail.
7. Apps Script updates the Sheet with `PUBLISHED`, the YouTube URL, or `FAILED` and the error.

## Troubleshooting

- **Gemini 429**: free-tier rate limit reached; wait for reset or reduce frequency.
- **Gemini 404/model error**: check current model availability and the model name in `Code.gs`.
- **Pixabay 401/403**: replace the API key and check API access.
- **No Pixabay results**: check the `footage_query` in the script response or broaden the English search terms.
- **GitHub 404/401**: check owner/repository spelling and PAT repository permissions.
- **GitHub workflow does not start**: ensure `daily.yml` is on the repository's default branch and the event type is `baaghi-video-ready`.
- **YouTube 401/invalid_grant**: check OAuth consent screen publishing status and regenerate the refresh token if necessary.
- **YouTube quota error**: check YouTube Data API quota in Google Cloud Console.
- **TTS disconnect/rate limit**: retry later; the Edge TTS endpoint is not a guaranteed API.
- **Bad pronunciation**: inspect `UrduVoiceScript` in the Sheet. Correct names or Arabic words before using the daily automation.

## Security and quality checklist

- Revoke the old Pixabay API key from the Make blueprint.
- Keep all secrets only in Apps Script Script Properties and GitHub Actions Secrets.
- Keep the GitHub repository private.
- Test with `unlisted`; switch to `public` only after reviewing the test video.
- Review religious references, voice pronunciation and footage rights before enabling unattended publishing.
