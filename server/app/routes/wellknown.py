import os

from flask import Blueprint, Response, jsonify

wellknown_bp = Blueprint("wellknown", __name__)

ANDROID_PACKAGE = os.environ.get("ANDROID_PACKAGE", "com.iotapp")
ANDROID_CERT_FINGERPRINTS = [
    f.strip()
    for f in os.environ.get(
        "ANDROID_CERT_FINGERPRINTS",
        "FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C",
    ).split(",")
    if f.strip()
]


# GET /.well-known/assetlinks.json
@wellknown_bp.route("/.well-known/assetlinks.json", methods=["GET"])
def assetlinks():
    return jsonify([
        {
            "relation": ["delegate_permission/common.handle_all_urls"],
            "target": {
                "namespace": "android_app",
                "package_name": ANDROID_PACKAGE,
                "sha256_cert_fingerprints": ANDROID_CERT_FINGERPRINTS,
            },
        }
    ])


# GET /invite  — 앱이 설치돼 있으면 OS가 가로채므로 여기까지 오지 않는다.
# 미설치 사용자에게 보여주는 폴백. 초대 코드는 읽지도 출력하지도 않는다.
@wellknown_bp.route("/invite", methods=["GET"])
def invite_fallback():
    html = """<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>기기 초대</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
       margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       padding:24px;color:#222}
  main{max-width:360px;text-align:center}
  h1{font-size:20px;margin:0 0 12px}
  p{font-size:15px;line-height:1.6;color:#555;margin:0}
</style>
<main>
  <h1>앱에서 열어주세요</h1>
  <p>기기 초대 링크입니다. 앱이 설치돼 있으면 자동으로 열립니다.<br>
     열리지 않으면 앱을 설치한 뒤 링크를 다시 눌러주세요.</p>
</main>"""
    return Response(html, mimetype="text/html")
