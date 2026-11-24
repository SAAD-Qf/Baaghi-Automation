import os, json, re, sys, subprocess, tempfile, textwrap, time
from pathlib import Path
import requests
import edge_tts
from PIL import Image, ImageDraw, ImageFont
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

WORK = Path("work")
WORK.mkdir(exist_ok=True)

def run(cmd):
    print("+", " ".join(map(str, cmd)), flush=True)
    subprocess.run(cmd, check=True)

def notify_gas(job_id, status, youtube_url="", error=""):
    url = os.environ.get("GAS_WEB_APP_URL", "")
    secret = os.environ.get("GAS_WEBHOOK_SECRET", "")
    if not url or not secret:
        print("GAS callback not configured; skipping status callback.")
        return
    try:
        r = requests.post(url, json={
            "secret": secret, "job_id": job_id, "status": status,
            "youtube_url": youtube_url, "error": error[:1500]
        }, timeout=40)
        print("GAS callback:", r.status_code, r.text[:300])
    except Exception as exc:
        print("GAS callback failed:", exc)

async def make_voice(text, output_file):
    # Split long narration into smaller requests, then join MP3 segments with FFmpeg.
    # Microsoft lists ur-PK-AsadNeural as Urdu (Pakistan), male neural voice.
    parts, current = [], ""
    sentences = re.split(r"(?<=[۔.!?؟])\s+|\n+", text)
    for sentence in sentences:
        sentence = sentence.strip()
        if not sentence:
            continue
        if len(sentence) > 2800:
            if current:
                parts.append(current); current = ""
            for start in range(0, len(sentence), 2600):
                parts.append(sentence[start:start + 2600])
            continue
        candidate = (current + " " + sentence).strip()
        if len(candidate) > 2800 and current:
            parts.append(current)
            current = sentence
        else:
            current = candidate
    if current:
        parts.append(current)
    if not parts:
        raise RuntimeError("No narration text available for TTS.")

    segment_paths = []
    for index, part in enumerate(parts, start=1):
        segment = WORK / f"voice_{index:03d}.mp3"
        communicate = edge_tts.Communicate(part, "ur-PK-AsadNeural", rate="+0%", volume="+0%")
        await communicate.save(str(segment))
        segment_paths.append(segment)

    concat_file = WORK / "audio_concat.txt"
    with open(concat_file, "w", encoding="utf-8") as handle:
        for segment in segment_paths:
            handle.write("file '" + segment.resolve().as_posix() + "'\n")
    run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(concat_file), "-c", "copy", str(output_file)])

def download_video(url, dest):
    with requests.get(url, stream=True, timeout=(30, 180), headers={"User-Agent":"Mozilla/5.0"}) as r:
        r.raise_for_status()
        total = 0
        with open(dest, "wb") as f:
            for chunk in r.iter_content(1024 * 1024):
                if chunk:
                    f.write(chunk); total += len(chunk)
                    if total > 900 * 1024 * 1024:
                        raise RuntimeError("Footage file exceeded 900 MB safety cap.")
    if os.path.getsize(dest) < 100_000:
        raise RuntimeError("Downloaded footage is unexpectedly small.")

def get_duration(path):
    out = subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", str(path)
    ], text=True).strip()
    return float(out)

def make_thumbnail(video_path, title, out_path):
    frame = WORK / "thumb_frame.jpg"
    run(["ffmpeg", "-y", "-ss", "00:00:04", "-i", str(video_path), "-frames:v", "1", str(frame)])
    im = Image.open(frame).convert("RGB").resize((1280, 720))
    overlay = Image.new("RGBA", im.size, (0,0,0,0))
    draw = ImageDraw.Draw(overlay)
    # Dark lower band to keep text legible.
    draw.rounded_rectangle((35, 430, 1245, 685), radius=28, fill=(0,0,0,185))
    font_path = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
    font = ImageFont.truetype(font_path, 58)
    words = title.split()
    lines, line = [], ""
    for word in words:
        trial = (line + " " + word).strip()
        if draw.textbbox((0,0), trial, font=font)[2] <= 1120:
            line = trial
        else:
            if line: lines.append(line)
            line = word
    if line: lines.append(line)
    lines = lines[:3]
    y = 470
    for line in lines:
        draw.text((65, y), line, font=font, fill=(255,255,255,255), stroke_width=2, stroke_fill=(0,0,0,220))
        y += 70
    Image.alpha_composite(im.convert("RGBA"), overlay).convert("RGB").save(out_path, "JPEG", quality=92)

def build_credentials():
    required = ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN"]
    missing = [x for x in required if not os.environ.get(x)]
    if missing: raise RuntimeError("Missing GitHub Actions secrets: " + ", ".join(missing))
    return Credentials(
        token=None,
        refresh_token=os.environ["YOUTUBE_REFRESH_TOKEN"],
        token_uri="https://oauth2.googleapis.com/token",
        client_id=os.environ["YOUTUBE_CLIENT_ID"],
        client_secret=os.environ["YOUTUBE_CLIENT_SECRET"],
        scopes=["https://www.googleapis.com/auth/youtube.upload"]
    )

def upload_video(video_path, thumb_path, job):
    credentials = build_credentials()
    youtube = build("youtube", "v3", credentials=credentials, cache_discovery=False)
    body = {
        "snippet": {
            "title": str(job["title"])[:100],
            "description": str(job.get("description", ""))[:4900] + "\n\nFootage source: Pixabay (Content License).",
            "tags": [str(x)[:100] for x in job.get("tags", [])][:15],
            "categoryId": str(job.get("category_id", "22"))
        },
        "status": {
            "privacyStatus": "public",
            "selfDeclaredMadeForKids": False
        }
    }
    media = MediaFileUpload(str(video_path), mimetype="video/mp4", chunksize=8*1024*1024, resumable=True)
    request = youtube.videos().insert(part="snippet,status", body=body, media_body=media)
    response = None
    while response is None:
        status, response = request.next_chunk()
        if status:
            print("YouTube upload progress: %.1f%%" % (status.progress() * 100), flush=True)
    video_id = response["id"]
    thumb_media = MediaFileUpload(str(thumb_path), mimetype="image/jpeg", resumable=False)
    youtube.thumbnails().set(videoId=video_id, media_body=thumb_media).execute()
    return "https://www.youtube.com/watch?v=" + video_id

def main():
    raw = os.environ.get("JOB_JSON", "")
    if not raw or raw == "null":
        raise RuntimeError("No job payload received. Trigger from Apps Script, not manual workflow_dispatch.")
    job = json.loads(raw)
    job_id = job["job_id"]
    try:
        roman = job["roman_script"]
        urdu = job["urdu_script"]
        if len(roman) < 2000 or len(urdu) < 1000:
            raise RuntimeError("Script failed minimum length check.")
        video_src = WORK / "footage.mp4"
        audio = WORK / "narration.mp3"
        final_video = WORK / "baaghi_scholor.mp4"
        thumb = WORK / "thumbnail.jpg"

        download_video(job["footage_url"], video_src)

        import asyncio
        asyncio.run(make_voice(urdu, audio))
        audio_duration = get_duration(audio)
        if audio_duration < 120:
            raise RuntimeError("Narration is under 2 minutes; stopping rather than publishing a short/empty video.")

        # Loop selected Pixabay clip to match the full narration, then encode H.264/AAC.
        run([
            "ffmpeg", "-y", "-stream_loop", "-1", "-i", str(video_src), "-i", str(audio),
            "-t", str(audio_duration),
            "-vf", "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,fps=30",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
            "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
            "-shortest", "-movflags", "+faststart", str(final_video)
        ])
        make_thumbnail(final_video, job.get("title", "Baaghi Scholor"), thumb)
        youtube_url = upload_video(final_video, thumb, job)
        notify_gas(job_id, "PUBLISHED", youtube_url, "")
        print("Published:", youtube_url)
    except Exception as exc:
        notify_gas(job_id, "FAILED", "", str(exc))
        raise

if __name__ == "__main__":
    main()
