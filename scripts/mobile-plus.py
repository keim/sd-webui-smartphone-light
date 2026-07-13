from modules import script_callbacks, shared, api
from modules.api import models
import gradio as gr
import os
import glob
import re
import json
from urllib.parse import quote
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import Response
from urllib.parse import urlparse
from urllib.request import Request, urlopen
from PIL import Image


PWA_MANIFEST_PATH = "/mobile-plus.webmanifest"
PWA_SERVICE_WORKER_PATH = "/mobile-plus-sw.js"
PWA_OFFLINE_PATH = "/mobile-plus-offline"
PWA_ICON_PATH_TEMPLATE = "/mobile-plus-icon-{size}.png"
FAVICON_ICO_PATH = "/mobile-plus-favicon.ico"
FAVICON_16_PATH = "/mobile-plus-favicon-16x16.png"
FAVICON_32_PATH = "/mobile-plus-favicon-32x32.png"


def _extension_root():
    return os.path.dirname(os.path.dirname(__file__))


def _manifest_file_path():
    return os.path.join(_extension_root(), "mobile-plus.webmanifest")


def _service_worker_file_path():
    return os.path.join(_extension_root(), "mobile-plus-sw.js")


def _offline_file_path():
    return os.path.join(_extension_root(), "mobile-plus-offline.html")


def _pwa_asset_version():
    candidates = [
        os.path.join(_extension_root(), "responsive.css"),
        os.path.join(_extension_root(), "style.css"),
        os.path.join(_extension_root(), "javascript", "responsive_design.js"),
        os.path.join(os.path.dirname(__file__), "panel.html"),
        _manifest_file_path(),
        _service_worker_file_path(),
        _offline_file_path(),
        os.path.join(_extension_root(), "icons", "favicon.ico"),
        os.path.join(_extension_root(), "icons", "icon-16.png"),
        os.path.join(_extension_root(), "icons", "icon-32.png"),
        os.path.join(_extension_root(), "icons", "icon-192.png"),
        os.path.join(_extension_root(), "icons", "icon-512.png"),
    ]
    mtimes = [str(int(os.path.getmtime(path))) for path in candidates if os.path.exists(path)]
    return "-".join(mtimes) or "1"


def _icon_file_path(filename: str):
    return os.path.join(_extension_root(), "icons", filename)


def _binary_file_response(path: str, media_type: str):
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail=f"Missing asset: {os.path.basename(path)}")
    with open(path, "rb") as f:
        return Response(content=f.read(), media_type=media_type)


def _pwa_icon_response(size: int):
    return _binary_file_response(_icon_file_path(f"icon-{size}.png"), "image/png")


def _favicon_response(filename: str, media_type: str):
    return _binary_file_response(_icon_file_path(filename), media_type)


def _manifest_response():
    return _binary_file_response(_manifest_file_path(), "application/manifest+json")


def _service_worker_response():
    return _binary_file_response(_service_worker_file_path(), "application/javascript")


def _offline_response():
    return _binary_file_response(_offline_file_path(), "text/html")


def on_ui_settings():
    section = ("mobile_plus", "Mobile+")
    shared.opts.add_option(
        "mobile_plus_replace_favicon",
        shared.OptionInfo(True, "Setup a1111 favicon", section=section))
    shared.opts.add_option(
        "mobile_plus_client_width_threshold",
        shared.OptionInfo(768, "Client width threshold (px)", section=section))
script_callbacks.on_ui_settings(on_ui_settings)


def on_ui_tabs():
    # Load HTML panel from external file
    panel_html_path = os.path.join(os.path.dirname(__file__), "panel.html")
    with open(panel_html_path, "r", encoding="utf-8") as f:
        panel_html = f.read()
    
    # Cache busting: Add version parameter to asset references
    version = _pwa_asset_version()
    panel_html = re.sub(
        r'((?:href|src)="(?!(?:https?:|data:)[^"]*\.(?:png|jpg|jpeg))([^"]+(\.(css|js|webmanifest)))")(?!\?v=)',
        rf'\1?v={version}"',
        panel_html
    )
    
    # Process latest images and extract prompts
    def get_prompt_history():
        prompts = process_latest_images()
        return json.dumps(prompts, ensure_ascii=False)
    
    with gr.Blocks() as interface:
        gr.Markdown("## Mobile Plus")
        gr.Markdown("Customize WebUI for mobile devices. Available only when the client width < 768px.")
        gr.HTML(panel_html)

        gr.Textbox(
            value = get_prompt_history,
            visible = False,
            elem_id = "sspp_prompt_history"
        )
        gr.Textbox(
            value=lambda: "true" if shared.opts.mobile_plus_replace_favicon else "false",
            visible=False,
            elem_id="sspp_replace_favicon"
        )
        gr.Textbox(
            value=lambda: str(int(shared.opts.mobile_plus_client_width_threshold)),
            visible=False,
            elem_id="sspp_client_width_threshold"
        )

        interface.load(
            fn=None, 
            inputs=None, 
            outputs=None, 
            _js="insertPanel"
        )
    
    return [(interface, "Mobile+", "mobile_plus")]
script_callbacks.on_ui_tabs(on_ui_tabs)


MAX_IMAGES = 200


def extract_pnginfo(image_path):
    try:
        img = Image.open(image_path)
        parameters = img.info.get('parameters')
        width, height = img.size
        
        if not parameters:
            return None
        
        result = {
            'positive_prompt': '',
            'negative_prompt': '',
            'width': width,
            'height': height,
            'steps': None,
            'sampler': None,
            'cfg_scale': None,
            'seed': None,
            'size': f"{width}x{height}",
            'model_hash': None,
            'model': None,
            'denoising_strength': None,
            'clip_skip': None,
            'ensd': None,
            'version': None,
            'hires_upscale': None,
            'hires_steps': None,
            'hires_upscaler': None,
            'vae': None,
            'vae_hash': None,
            'lora_hashes': None,
            'ti_hashes': None,
            'schedule_type': None,
            'schedule_rho': None,
            'sgm_noise_multiplier': None,
            'all_params_text': parameters  # Store original parameters text
        }
        
        # Extract positive prompt (everything before "Negative prompt:")
        if "Negative prompt:" in parameters:
            parts = parameters.split("Negative prompt:", 1)
            result['positive_prompt'] = parts[0].strip()
            
            # Extract negative prompt and other parameters
            remaining = parts[1]
            if "\nSteps:" in remaining:
                negative_and_params = remaining.split("\nSteps:", 1)
                result['negative_prompt'] = negative_and_params[0].strip()
                params_text = "Steps:" + negative_and_params[1]
            else:
                # Try other common parameter markers
                param_markers = ["\nSampler:", "\nCFG scale:", "\nSeed:", "\nSize:"]
                found_marker = False
                for marker in param_markers:
                    if marker in remaining:
                        negative_and_params = remaining.split(marker, 1)
                        result['negative_prompt'] = negative_and_params[0].strip()
                        params_text = marker.strip() + ":" + negative_and_params[1]
                        found_marker = True
                        break
                if not found_marker:
                    result['negative_prompt'] = remaining.strip()
                    params_text = ""
        else:
            # No negative prompt section
            if "\nSteps:" in parameters:
                parts = parameters.split("\nSteps:", 1)
                result['positive_prompt'] = parts[0].strip()
                params_text = "Steps:" + parts[1]
            else:
                result['positive_prompt'] = parameters.strip()
                params_text = ""
        
        # Parse all parameters from the params_text
        if params_text:
            # Split by comma, but be careful with nested structures
            param_pairs = []
            current_pair = ""
            paren_depth = 0
            bracket_depth = 0
            
            for char in params_text:
                if char == '(':
                    paren_depth += 1
                elif char == ')':
                    paren_depth -= 1
                elif char == '[':
                    bracket_depth += 1
                elif char == ']':
                    bracket_depth -= 1
                elif char == ',' and paren_depth == 0 and bracket_depth == 0:
                    param_pairs.append(current_pair.strip())
                    current_pair = ""
                    continue
                current_pair += char
            
            if current_pair.strip():
                param_pairs.append(current_pair.strip())
            
            # Parse each parameter pair
            for pair in param_pairs:
                if ':' not in pair:
                    continue
                
                key, value = pair.split(':', 1)
                key = key.strip().lower().replace(' ', '_')
                value = value.strip()
                
                # Remove quotes if present
                if value.startswith('"') and value.endswith('"'):
                    value = value[1:-1]
                
                # Map to result dictionary
                if key == 'steps':
                    result['steps'] = int(value) if value.isdigit() else value
                elif key == 'sampler':
                    result['sampler'] = value
                elif key == 'cfg_scale':
                    try:
                        result['cfg_scale'] = float(value)
                    except ValueError:
                        result['cfg_scale'] = value
                elif key == 'seed':
                    result['seed'] = int(value) if value.isdigit() else value
                elif key == 'size':
                    result['size'] = value
                elif key == 'model_hash':
                    result['model_hash'] = value
                elif key == 'model':
                    result['model'] = value
                elif key == 'denoising_strength':
                    try:
                        result['denoising_strength'] = float(value)
                    except ValueError:
                        result['denoising_strength'] = value
                elif key == 'clip_skip':
                    result['clip_skip'] = int(value) if value.isdigit() else value
                elif key == 'ensd':
                    result['ensd'] = value
                elif key == 'version':
                    result['version'] = value
                elif key == 'hires_upscale':
                    try:
                        result['hires_upscale'] = float(value)
                    except ValueError:
                        result['hires_upscale'] = value
                elif key == 'hires_steps':
                    result['hires_steps'] = int(value) if value.isdigit() else value
                elif key == 'hires_upscaler':
                    result['hires_upscaler'] = value
                elif key == 'vae':
                    result['vae'] = value
                elif key == 'vae_hash':
                    result['vae_hash'] = value
                elif key == 'lora_hashes':
                    result['lora_hashes'] = value
                elif key == 'ti_hashes':
                    result['ti_hashes'] = value
                elif key == 'schedule_type':
                    result['schedule_type'] = value
                elif key == 'schedule_rho':
                    try:
                        result['schedule_rho'] = float(value)
                    except ValueError:
                        result['schedule_rho'] = value
                elif key == 'sgm_noise_multiplier':
                    try:
                        result['sgm_noise_multiplier'] = float(value)
                    except ValueError:
                        result['sgm_noise_multiplier'] = value
                else:
                    # Store any unknown parameters
                    result[key] = value
        
        return result
        
    except Exception as e:
        print(f"[Mobile+] Error processing {image_path}: {e}")
        return None

def process_latest_images():
    webui_root = os.getcwd()
    full_image_dir = os.path.join(webui_root, shared.opts.outdir_save)

    if not os.path.exists(full_image_dir):
        print(f"[Mobile+] Image directory not found: {full_image_dir}")
        return []
    
    # Get all PNG files sorted by modification time (newest first)
    search_pattern = os.path.join(full_image_dir, "**", "*.png")
    image_files = glob.glob(search_pattern, recursive=True)
    image_files.sort(key=os.path.getmtime, reverse=True)
    
    # Process only the latest MAX_IMAGES
    prompts = []
    seen_prompts = set()
    for image_path in image_files[:MAX_IMAGES]:
        pnginfo = extract_pnginfo(image_path)
        # convert image_path to image url link (relative to webui root) and URL-encode
        rel_path = os.path.relpath(image_path, webui_root).replace(os.sep, '/')
        url = f"/file={quote(rel_path)}"

        if pnginfo:
            # Trim whitespace, replace consecutive whitespace (including full-width) with single space, and avoid duplicates
            posiprompt = re.sub(r'[ \t\u3000]+', ' ', pnginfo['positive_prompt'].strip())
            negaprompt = re.sub(r'[ \t\u3000]+', ' ', pnginfo['negative_prompt'].strip())
            seen_prompt = posiprompt + negaprompt
            if seen_prompt and seen_prompt not in seen_prompts:
                prompts.append([url, posiprompt, negaprompt, pnginfo['width'], pnginfo['height']])
                seen_prompts.add(seen_prompt)
    
    print(f"[Mobile+] Extracted {len(prompts)} prompts from latest images")
    return prompts

def get_images_from_directory(dir_path: str, start: int = 0, count: int = 50) -> dict:
    try:
        webui_root = os.getcwd()
        full_dir = os.path.join(webui_root, dir_path)

        if not os.path.exists(full_dir):
            print(f"[Mobile+] Image directory not found: {full_dir}")
            return {"success": False, "images": [], "message": "Directory not found"}
        
        # Get all PNG files sorted by modification time (newest first)
        search_pattern = os.path.join(full_dir, "**", "*.png")
        image_files = glob.glob(search_pattern, recursive=True)
        image_files.sort(key=os.path.getmtime, reverse=True)

        images = []
        # query parameter で指定されたstartから開始してcount数だけ処理
        for image_path in image_files[start:start + count]:
            pnginfo = extract_pnginfo(image_path)
            
            if pnginfo:
                # convert image_path to image url link (relative to webui root) and URL-encode
                rel_path = os.path.relpath(image_path, webui_root).replace(os.sep, '/')
                url = f"/file={quote(rel_path)}"
                
                # Create image data with all parameters
                image_data = {
                    "url": url,
                    "positive_prompt": pnginfo['positive_prompt'].strip(),
                    "negative_prompt": pnginfo['negative_prompt'].strip(),
                    "width": pnginfo['width'],
                    "height": pnginfo['height'],
                    "size": pnginfo['size'],
                    "steps": pnginfo['steps'],
                    "sampler": pnginfo['sampler'],
                    "cfg_scale": pnginfo['cfg_scale'],
                    "seed": pnginfo['seed'],
                    "model": pnginfo['model'],
                    "model_hash": pnginfo['model_hash'],
                    "denoising_strength": pnginfo['denoising_strength'],
                    "clip_skip": pnginfo['clip_skip'],
                    "ensd": pnginfo['ensd'],
                    "version": pnginfo['version'],
                    "hires_upscale": pnginfo['hires_upscale'],
                    "hires_steps": pnginfo['hires_steps'],
                    "hires_upscaler": pnginfo['hires_upscaler'],
                    "vae": pnginfo['vae'],
                    "vae_hash": pnginfo['vae_hash'],
                    "lora_hashes": pnginfo['lora_hashes'],
                    "ti_hashes": pnginfo['ti_hashes'],
                    "schedule_type": pnginfo['schedule_type'],
                    "schedule_rho": pnginfo['schedule_rho'],
                    "sgm_noise_multiplier": pnginfo['sgm_noise_multiplier']
                }
                
                # Add any additional unknown parameters
                for key, value in pnginfo.items():
                    if key not in image_data and key != 'all_params_text':
                        image_data[key] = value
                
                images.append(image_data)

        return {
            "success": True, 
            "images": images,
            "total": len(images),
            "start": start,
            "count": count
        }
    except Exception as e:
        print(f"[Mobile+] Error in get_images_from_directory: {e}")
        import traceback
        traceback.print_exc()
        return {"success": False, "images": [], "message": str(e)}

# Fetch remote image with size limit and content type check
def fetch_remote_image(url: str, timeout: int = 10, max_bytes: int = 20 * 1024 * 1024):
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise HTTPException(status_code=400, detail="Only http/https URLs are allowed")

    req = Request(url, headers={"User-Agent": "sd-webui-mobile-plus"})
    try:
        with urlopen(req, timeout=timeout) as resp:
            content_type = resp.headers.get("Content-Type", "application/octet-stream")
            data = resp.read(max_bytes + 1)
            if len(data) > max_bytes:
                raise HTTPException(status_code=413, detail="Image too large")
            if not content_type.startswith("image/"):
                raise HTTPException(status_code=400, detail="Target URL is not an image")
            return data, content_type
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to fetch image: {e}")


# API routes
def on_app_started(demo, app: FastAPI):
    @app.get(FAVICON_ICO_PATH)
    async def favicon_ico():
        return _favicon_response("favicon.ico", "image/x-icon")

    @app.get(FAVICON_16_PATH)
    async def favicon_16():
        return _favicon_response("icon-16.png", "image/png")

    @app.get(FAVICON_32_PATH)
    async def favicon_32():
        return _favicon_response("icon-32.png", "image/png")

    @app.get(PWA_MANIFEST_PATH)
    async def pwa_manifest():
        response = _manifest_response()
        response.headers["Cache-Control"] = "no-cache"
        response.headers["X-Asset-Version"] = _pwa_asset_version()
        return response

    @app.get(PWA_SERVICE_WORKER_PATH)
    async def pwa_service_worker():
        response = _service_worker_response()
        response.headers["Cache-Control"] = "no-cache"
        response.headers["Service-Worker-Allowed"] = "/"
        response.headers["X-Asset-Version"] = _pwa_asset_version()
        return response

    @app.get(PWA_OFFLINE_PATH)
    async def pwa_offline():
        response = _offline_response()
        response.headers["Cache-Control"] = "no-cache"
        response.headers["X-Asset-Version"] = _pwa_asset_version()
        return response

    @app.get(PWA_ICON_PATH_TEMPLATE.format(size=192))
    async def pwa_icon_192():
        return _pwa_icon_response(192)

    @app.get(PWA_ICON_PATH_TEMPLATE.format(size=512))
    async def pwa_icon_512():
        return _pwa_icon_response(512)

    @app.get("/api/mobile-plus/txt2img")
    async def txt2img(start: int = Query(0, ge=0), count: int = Query(50, ge=1, le=500)):
        result = get_images_from_directory(shared.opts.outdir_txt2img_samples, start, count)
        return result
    
    @app.get("/api/mobile-plus/img2img")
    async def img2img(start: int = Query(0, ge=0), count: int = Query(50, ge=1, le=500)):
        result = get_images_from_directory(shared.opts.outdir_img2img_samples, start, count)
        return result
    
    @app.get("/api/mobile-plus/outdir")
    async def outdir(start: int = Query(0, ge=0), count: int = Query(50, ge=1, le=500)):
        result = get_images_from_directory(shared.opts.outdir_save, start, count)
        return result

    @app.get("/api/mobile-plus/proxy-image")
    async def proxy_image(url: str = Query(..., min_length=8, max_length=2048)):
        data, content_type = fetch_remote_image(url)
        return Response(content=data, media_type=content_type)
script_callbacks.on_app_started(on_app_started)


print("[Mobile+] Mobile+ extension loaded.")
