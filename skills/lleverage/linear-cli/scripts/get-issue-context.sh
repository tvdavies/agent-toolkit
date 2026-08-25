#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/_check-deps.sh"

# get-issue-context: Extract all contextual media from a Linear issue
# Downloads images, Loom video frames (at best available resolution), and transcripts.
# Usage: get-issue-context.sh [OPTIONS] ISSUE_ID
#   --comments     Also check comments for media
#   --dir DIR      Output directory (default: /tmp/linear-context)
#   --help         Show this help

INCLUDE_COMMENTS=false
OUTPUT_DIR="/tmp/linear-context"
ISSUE_ID=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --comments) INCLUDE_COMMENTS=true; shift ;;
        --dir) OUTPUT_DIR="$2"; shift 2 ;;
        --help|-h)
            echo "Usage: get-issue-context.sh [OPTIONS] ISSUE_ID"
            echo ""
            echo "Extract all contextual media from a Linear issue:"
            echo "  - Screenshots/images from description and comments"
            echo "  - Loom video frames and transcripts"
            echo ""
            echo "Downloads the best available resolution for Loom videos:"
            echo "  - Thumbnail MP4 (1280x720) for high-res frames"
            echo "  - Full-play GIF for complete video coverage"
            echo "  - Transcript when audio is present"
            echo ""
            echo "Options:"
            echo "  --comments     Also check comments for media"
            echo "  --dir DIR      Output directory (default: /tmp/linear-context)"
            echo "  --help         Show this help"
            echo ""
            echo "Output: JSON with paths to all downloaded files."
            echo "Use the Read tool to view each image file for visual context."
            exit 0
            ;;
        -*) echo "Unknown option: $1" >&2; exit 1 ;;
        *) ISSUE_ID="$1"; shift ;;
    esac
done

if [ -z "$ISSUE_ID" ]; then
    echo "Error: Issue ID is required (e.g., LLE-123)" >&2
    exit 1
fi

mkdir -p "$OUTPUT_DIR"

# Clean up previous files for this issue to avoid stale data
rm -f "$OUTPUT_DIR/${ISSUE_ID}-"* 2>/dev/null || true

# Get issue details
ISSUE_JSON=$(linear-cli issues get "$ISSUE_ID" --output json --compact --no-pager --quiet 2>/dev/null)
DESCRIPTION=$(echo "$ISSUE_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('description','') or '')" 2>/dev/null)

# Write all text to a temp file (avoids env var size limits for large descriptions)
TEXT_FILE=$(mktemp)
trap 'rm -f "$TEXT_FILE"' EXIT

echo "$DESCRIPTION" > "$TEXT_FILE"

if [ "$INCLUDE_COMMENTS" = true ]; then
    linear-cli issues get "$ISSUE_ID" --comments --output json --compact --no-pager --quiet 2>/dev/null | \
        python3 -c "
import sys, json
data = json.load(sys.stdin)
comments = data.get('comments', [])
if isinstance(comments, dict):
    comments = comments.get('nodes', [])
for c in comments:
    print(c.get('body', '') or '')
" >> "$TEXT_FILE" 2>/dev/null || true
fi

python3 - "$ISSUE_ID" "$OUTPUT_DIR" "$TEXT_FILE" << 'PYEOF'
import re, json, subprocess, sys, os, shutil

issue_id = sys.argv[1]
output_dir = sys.argv[2]
with open(sys.argv[3], "r") as f:
    all_text = f.read()

has_ffmpeg = shutil.which("ffmpeg") is not None

results = {
    "issue": issue_id,
    "images": [],
    "loom_videos": [],
}

def run(cmd, **kwargs):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=kwargs.get("timeout", 30))

# --- Extract and download Linear upload images ---
md_images = re.findall(r'!\[([^\]]*)\]\(([^)]+)\)', all_text)
bare_uploads = re.findall(r'(https://uploads\.linear\.app/[^\s\)\]]+)', all_text)

seen_urls = set()
image_urls = []
for alt, url in md_images:
    if url not in seen_urls and 'uploads.linear.app' in url:
        seen_urls.add(url)
        image_urls.append((alt, url))
for url in bare_uploads:
    if url not in seen_urls:
        seen_urls.add(url)
        image_urls.append(("", url))

for i, (alt, url) in enumerate(image_urls):
    filename = alt if alt else f"image_{i+1}"
    filename = re.sub(r'[^\w\-\. ]', '_', filename)
    if not re.search(r'\.(png|jpg|jpeg|gif|webp|svg|mp4|mov|pdf)$', filename, re.I):
        filename += ".png"
    outpath = os.path.join(output_dir, f"{issue_id}-{filename}")

    try:
        subprocess.run(
            ["linear-cli", "uploads", "fetch", url, "-f", outpath, "--quiet"],
            capture_output=True, timeout=60
        )
        if os.path.exists(outpath):
            results["images"].append({"path": outpath, "alt": alt})
    except Exception as e:
        print(f"Warning: Failed to download image: {e}", file=sys.stderr)

# --- Extract Loom links and get context ---
# Linear markdown wraps URLs in various formats:
#   [text](http://loom.com/share/ID?params)
#   [text](<http://loom.com/share/ID?params>)
#   https://www.loom.com/share/ID
#   bare loom.com/share/ID
loom_patterns = [
    r'https?://(?:www\.)?loom\.com/share/([a-f0-9]+)',
    r'(?:^|[(\s<])loom\.com/share/([a-f0-9]+)',
]

loom_ids = set()
for pattern in loom_patterns:
    for match in re.finditer(pattern, all_text):
        # finditer groups: pick the first non-None group
        for g in match.groups():
            if g:
                loom_ids.add(g)
                break

for loom_id in loom_ids:
    loom_info = {"id": loom_id, "url": f"https://www.loom.com/share/{loom_id}", "frames": []}
    thumb_base = None

    # Step 1: Get oEmbed data (title, duration, thumbnail base URL)
    try:
        oembed_url = f"https://www.loom.com/v1/oembed?url=https://www.loom.com/share/{loom_id}"
        r = run(["curl", "-sL", oembed_url])
        if r.returncode == 0 and r.stdout.strip():
            oembed = json.loads(r.stdout)
            loom_info["title"] = oembed.get("title", "")
            loom_info["duration_seconds"] = oembed.get("duration", 0)
            thumb_url = oembed.get("thumbnail_url", "")
            if thumb_url:
                # Derive the base URL for all thumbnail assets
                # thumbnail_url is like: https://cdn.loom.com/sessions/thumbnails/ID-HASH.gif
                # Other assets: ID-HASH.mp4, ID-HASH.jpg, ID-HASH-full-play.gif
                thumb_base = thumb_url.rsplit('.', 1)[0]  # remove .gif extension
    except Exception as e:
        print(f"Warning: oEmbed failed: {e}", file=sys.stderr)

    if not thumb_base:
        results["loom_videos"].append(loom_info)
        continue

    # Step 2: Try to get transcript from the Loom page
    try:
        r = run(["curl", "-sL", f"https://www.loom.com/share/{loom_id}"], timeout=15)
        if r.returncode == 0:
            html = r.stdout
            # Try captions array
            cap_match = re.search(r'"captions"\s*:\s*(\[.*?\])\s*[,}]', html)
            if cap_match:
                try:
                    captions = json.loads(cap_match.group(1))
                    lines = [c.get("text", "") or c.get("value", "") for c in captions]
                    lines = [l for l in lines if l]
                    if lines:
                        transcript = " ".join(lines)
                        path = os.path.join(output_dir, f"{issue_id}-loom-{loom_id}-transcript.txt")
                        with open(path, "w") as f:
                            f.write(transcript)
                        loom_info["transcript"] = transcript
                        loom_info["transcript_path"] = path
                except json.JSONDecodeError:
                    pass

            # Try transcription_text field
            if "transcript" not in loom_info:
                ts_match = re.search(r'"transcription_text"\s*:\s*"([^"]*)"', html)
                if ts_match:
                    t = ts_match.group(1).encode().decode('unicode_escape')
                    if t and t != "null":
                        path = os.path.join(output_dir, f"{issue_id}-loom-{loom_id}-transcript.txt")
                        with open(path, "w") as f:
                            f.write(t)
                        loom_info["transcript"] = t
                        loom_info["transcript_path"] = path
    except Exception as e:
        print(f"Warning: transcript extraction failed: {e}", file=sys.stderr)

    if "transcript" not in loom_info:
        loom_info["transcript"] = None

    # Step 3: Download video frames
    if has_ffmpeg:
        duration = loom_info.get("duration_seconds", 0)

        # Strategy A: Thumbnail MP4 at 1280x720 (first ~4s of video)
        mp4_url = f"{thumb_base}.mp4"
        mp4_path = os.path.join(output_dir, f"{issue_id}-loom-{loom_id}-hq.mp4")
        try:
            r = run(["curl", "-sL", mp4_url, "-o", mp4_path], timeout=30)
            if os.path.exists(mp4_path) and os.path.getsize(mp4_path) > 1000:
                # Extract 1 frame per second from the high-res MP4
                frame_pattern = os.path.join(output_dir, f"{issue_id}-loom-{loom_id}-hq-frame_%03d.jpg")
                subprocess.run(
                    ["ffmpeg", "-y", "-i", mp4_path, "-vf", "fps=1", "-q:v", "2", frame_pattern],
                    capture_output=True, timeout=30
                )
                # Collect frame paths
                for f in sorted(os.listdir(output_dir)):
                    if f.startswith(f"{issue_id}-loom-{loom_id}-hq-frame_") and f.endswith(".jpg"):
                        loom_info["frames"].append({
                            "path": os.path.join(output_dir, f),
                            "resolution": "1280x720",
                            "source": "thumbnail_mp4"
                        })
                os.remove(mp4_path)  # clean up MP4
        except Exception as e:
            print(f"Warning: MP4 frame extraction failed: {e}", file=sys.stderr)

        # Strategy B: Full-play GIF at 640x360 (covers entire video)
        # Only extract if video is longer than what the MP4 thumbnail covers (~4s)
        if duration > 5:
            gif_url = f"{thumb_base}-full-play.gif"
            gif_path = os.path.join(output_dir, f"{issue_id}-loom-{loom_id}-fullplay.gif")
            try:
                r = run(["curl", "-sL", gif_url, "-o", gif_path], timeout=30)
                if os.path.exists(gif_path) and os.path.getsize(gif_path) > 1000:
                    # Extract frames - use scene detection to avoid redundant frames
                    frame_pattern = os.path.join(output_dir, f"{issue_id}-loom-{loom_id}-full-frame_%03d.jpg")
                    # For longer videos, extract 1 frame every 2 seconds; for short ones, every 1s
                    fps = "0.5" if duration > 20 else "1"
                    subprocess.run(
                        ["ffmpeg", "-y", "-i", gif_path, "-vf", f"fps={fps}", "-q:v", "2", frame_pattern],
                        capture_output=True, timeout=30
                    )
                    for f in sorted(os.listdir(output_dir)):
                        if f.startswith(f"{issue_id}-loom-{loom_id}-full-frame_") and f.endswith(".jpg"):
                            loom_info["frames"].append({
                                "path": os.path.join(output_dir, f),
                                "resolution": "640x360",
                                "source": "fullplay_gif"
                            })
                    os.remove(gif_path)  # clean up GIF
            except Exception as e:
                print(f"Warning: GIF frame extraction failed: {e}", file=sys.stderr)
    else:
        # No ffmpeg - just download the static thumbnail JPG
        jpg_url = f"{thumb_base}.jpg"
        jpg_path = os.path.join(output_dir, f"{issue_id}-loom-{loom_id}-thumbnail.jpg")
        try:
            r = run(["curl", "-sL", jpg_url, "-o", jpg_path], timeout=15)
            if os.path.exists(jpg_path) and os.path.getsize(jpg_path) > 1000:
                loom_info["frames"].append({
                    "path": jpg_path,
                    "resolution": "1280x720",
                    "source": "static_thumbnail"
                })
        except Exception as e:
            print(f"Warning: thumbnail download failed: {e}", file=sys.stderr)

    results["loom_videos"].append(loom_info)

print(json.dumps(results, indent=2))
PYEOF
