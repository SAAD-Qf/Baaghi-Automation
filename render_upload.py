import os, json, re, subprocess, time
from pathlib import Path

import requests
import edge_tts
from PIL import Image, ImageDraw, ImageFont
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

WORK = Path("work")
WORK.mkdir(exist_ok=True)
VOICE = "ur-PK-AsadNeural"
MIN_VIDEO_SECONDS = 120
MAX_SCENES = 20


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
        r.raise_for_status()
    except Exception as exc:
        print("GAS callback failed:", exc)


def split_text(text, limit=2600):
    parts, current = [], ""
    sentences = re.split(r"(?<=[۔.!?؟])\s+|\n+", str(text))
    for sentence in sentences:
        sentence = sentence.strip()
        if not sentence:
            continue
        if len(sentence) > limit:
            if current:
                parts.append(current)
                current = ""
            parts.extend(sentence[i:i + limit] for i in range(0, len(sentence), limit))
            continue
        candidate = (current + " " + sentence).strip()
        if len(candidate) > limit and current:
            parts.append(current)
            current = sentence
        else:
            current = candidate
    if current:
        parts.append(current)
    return parts


async def make_voice(text, output_file, prefix):
    parts = split_text(text)
    if not parts:
        raise RuntimeError(f"No narration text in {prefix}.")
    paths = []
    for index, part in enumerate(parts, 1):
        segment = WORK / f"{prefix}_voice_{index:03d}.mp3"
        await edge_tts.Communicate(
            part, VOICE, rate="+0%", volume="+0%"
        ).save(str(segment))
        paths.append(segment)
    concat = WORK / f"{prefix}_audio_concat.txt"
    with concat.open("w", encoding="utf-8") as f:
        for p in paths:
            f.write("file '" + p.resolve().as_posix().replace("'", r"'\''") + "'\n")
    run(["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(concat),
         "-c:a", "libmp3lame", "-q:a", "2", str(output_file)])


def download_video(url, dest):
    if not url:
        raise RuntimeError("A scene is missing its Pixabay footage URL.")
    for attempt in range(5):
        try:
            with requests.get(url, stream=True, timeout=(30, 180),
                              headers={"User-Agent": "Mozilla/5.0"}) as r:
                if r.status_code == 429:
                    wait = 20 * (attempt + 1)
                    print(f"Pixabay rate limit. Waiting {wait} seconds...")
                    time.sleep(wait)
                    continue
                r.raise_for_status()
                total = 0
                with open(dest, "wb") as f:
                    for chunk in r.iter_content(1024 * 1024):
                        if chunk:
                            f.write(chunk)
                            total += len(chunk)
                            if total > 900 * 1024 * 1024:
                                raise RuntimeError("Footage exceeded 900 MB safety cap.")
            if os.path.getsize(dest) < 100_000:
                raise RuntimeError("Downloaded footage is unexpectedly small.")
            return
        except requests.RequestException:
            if attempt == 4:
                raise
            time.sleep(10 * (attempt + 1))
    raise RuntimeError("Video download failed after 5 attempts.")


def get_duration(path):
    out = subprocess.check_output([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", str(path)
    ], text=True).strip()
    return float(out)


def make_thumbnail(video_path, title, out_path):
    frame = WORK / "thumb_frame.jpg"
    run(["ffmpeg", "-y", "-ss", "00:00:04", "-i", str(video_path),
         "-frames:v", "1", str(frame)])
    im = Image.open(frame).convert("RGB").resize((1280, 720))
    overlay = Image.new("RGBA", im.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    draw.rounded_rectangle((35, 430, 1245, 685), radius=28, fill=(0, 0, 0, 185))
    font_path = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
    font = ImageFont.truetype(font_path, 54)
    lines, line = [], ""
    for word in str(title).split():
        trial = (line + " " + word).strip()
        if draw.textbbox((0, 0), trial, font=font)[2] <= 1120:
            line = trial
        else:
            if line:
                lines.append(line)
            line = word
    if line:
        lines.append(line)
    y = 465
    for line in lines[:3]:
        draw.text((65, y), line, font=font, fill=(255, 255, 255, 255),
                  stroke_width=2, stroke_fill=(0, 0, 0, 220))
        y += 68
    Image.alpha_composite(im.convert("RGBA"), overlay).convert("RGB").save(
        out_path, "JPEG", quality=92
    )


def build_credentials():
    required = ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN"]
    missing = [x for x in required if not os.environ.get(x)]
    if missing:
        raise RuntimeError("Missing GitHub Actions secrets: " + ", ".join(missing))
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
            "title": str(job.get("title", "Baaghi Scholor"))[:100],
            "description": str(job.get("description", ""))[:4900] +
                "\n\nFootage source: Pixabay (Content License).",
            "tags": [str(x)[:100] for x in job.get("tags", [])][:15],
            "categoryId": str(job.get("category_id", "22"))
        },
        "status": {
            "privacyStatus": str(job.get("privacy_status", "public")),
            "selfDeclaredMadeForKids": False
        }
    }
    media = MediaFileUpload(str(video_path), mimetype="video/mp4",
                            chunksize=8 * 1024 * 1024, resumable=True)
    request = youtube.videos().insert(
        part="snippet,status", body=body, media_body=media
    )
    response = None
    while response is None:
        status, response = request.next_chunk()
        if status:
            print("YouTube upload progress: %.1f%%" % (status.progress() * 100),
                  flush=True)
    video_id = response["id"]
    youtube_url = "https://www.youtube.com/watch?v=" + video_id

    # Thumbnail failure must not turn an already-published video into a failed job.
    try:
        thumb_media = MediaFileUpload(str(thumb_path), mimetype="image/jpeg",
                                      resumable=False)
        youtube.thumbnails().set(
            videoId=video_id, media_body=thumb_media
        ).execute()
        print("Custom thumbnail uploaded.")
    except Exception as exc:
        print("WARNING: Video uploaded, but custom thumbnail was not set:", exc)
    return youtube_url


def normalize_scenes(job):
    scenes = job.get("scenes")
    if not isinstance(scenes, list) or not scenes:
        raise RuntimeError(
            "This job has no scene list. Update Apps Script first; "
            "legacy single-footage jobs are intentionally not rendered."
        )
    if len(scenes) > MAX_SCENES:
        raise RuntimeError(f"Too many scenes ({len(scenes)}); maximum is {MAX_SCENES}.")
    clean = []
    for i, scene in enumerate(scenes, 1):
        if not isinstance(scene, dict):
            raise RuntimeError(f"Scene {i} is not an object.")
        text = str(scene.get("urdu_text", "")).strip()
        url = str(scene.get("footage_url", "")).strip()
        if len(text) < 20:
            raise RuntimeError(f"Scene {i} has missing/too-short Urdu narration.")
        if not url.startswith("https://"):
            raise RuntimeError(f"Scene {i} has no valid HTTPS footage URL.")
        clean.append({"urdu_text": text, "footage_url": url})
    return clean


def render_scenes(scenes):
    import asyncio
    audio_paths, video_paths = [], []
    total_audio = 0.0

    for i, scene in enumerate(scenes, 1):
        prefix = f"scene_{i:02d}"
        print(f"\n--- Rendering scene {i}/{len(scenes)} ---", flush=True)
        audio = WORK / f"{prefix}.mp3"
        footage = WORK / f"{prefix}_footage.mp4"
        segment_video = WORK / f"{prefix}_video.mp4"

        asyncio.run(make_voice(scene["urdu_text"], audio, prefix))
        duration = get_duration(audio)
        if duration <= 0:
            raise RuntimeError(f"Scene {i} produced empty audio.")
        download_video(scene["footage_url"], footage)

        # Each scene's visual clip is looped/cut to precisely its own voice duration.
        run([
            "ffmpeg", "-y", "-stream_loop", "-1", "-i", str(footage),
            "-t", f"{duration:.3f}",
            "-vf", "scale=1920:1080:force_original_aspect_ratio=increase,"
                   "crop=1920:1080,fps=30,setsar=1",
            "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart",
            str(segment_video)
        ])
        audio_paths.append(audio)
        video_paths.append(segment_video)
        total_audio += duration
        print(f"Scene {i} voice duration: {duration:.2f}s", flush=True)

    if total_audio < MIN_VIDEO_SECONDS:
        raise RuntimeError(
            f"Total narration is only {total_audio:.1f}s; "
            "stopping rather than publishing a short video."
        )

    video_list = WORK / "video_segments.txt"
    with video_list.open("w", encoding="utf-8") as f:
        for p in video_paths:
            f.write("file '" + p.resolve().as_posix() + "'\n")
    joined_video = WORK / "joined_video.mp4"
    run([
        "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(video_list),
        "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-pix_fmt", "yuv420p", "-r", "30", str(joined_video)
    ])

    audio_list = WORK / "audio_segments.txt"
    with audio_list.open("w", encoding="utf-8") as f:
        for p in audio_paths:
            f.write("file '" + p.resolve().as_posix() + "'\n")
    joined_audio = WORK / "joined_audio.mp3"
    run([
        "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(audio_list),
        "-c:a", "libmp3lame", "-q:a", "2", str(joined_audio)
    ])

    final_video = WORK / "baaghi_scholor.mp4"
    run([
        "ffmpeg", "-y", "-i", str(joined_video), "-i", str(joined_audio),
        "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        "-shortest", "-movflags", "+faststart", str(final_video)
    ])
    return final_video


def main():
    raw = os.environ.get("JOB_JSON", "")
    if not raw or raw == "null":
        raise RuntimeError(
            "No job payload received. Trigger from Apps Script, not manual workflow_dispatch."
        )
    job = json.loads(raw)
    job_id = str(job.get("job_id", ""))
    if not job_id:
        raise RuntimeError("Job payload is missing job_id.")
    try:
        scenes = normalize_scenes(job)
        final_video = render_scenes(scenes)
        thumb = WORK / "thumbnail.jpg"
        make_thumbnail(final_video, job.get("title", "Baaghi Scholor"), thumb)
        youtube_url = upload_video(final_video, thumb, job)
        notify_gas(job_id, "PUBLISHED", youtube_url, "")
        print("Published:", youtube_url)
    except Exception as exc:
        notify_gas(job_id, "FAILED", "", str(exc))
        raise


if __name__ == "__main__":
    main()
