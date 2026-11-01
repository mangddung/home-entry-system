from dotenv import load_dotenv
load_dotenv()

import os
import firebase_admin
from firebase_admin import credentials

from flask import Flask
from flask_cors import CORS

from app.utils.cleanup import start_cleanup_loop
from app.utils.database import init_db
from app.utils.limiter import limiter
from app.routes.client.auth import auth_bp
from app.routes.client.oauth import kakao_bp
from app.routes.client.devices import client_bp
from app.routes.client.members import member_bp
from app.routes.client.fcm import fcm_bp
from app.routes.client.logs import logs_bp
from app.routes.admin.devices import admin_bp
from app.routes.admin.members import admin_member_bp
from app.routes.iot.init import iot_bp
from app.routes.wellknown import wellknown_bp

FIREBASE_CREDENTIAL_PATH = os.getenv("FIREBASE_CREDENTIAL_PATH")
cred = credentials.Certificate(FIREBASE_CREDENTIAL_PATH)
firebase_admin.initialize_app(cred)

def create_app():
    app = Flask(__name__)

    CORS(app)
    limiter.init_app(app)

    init_db()
    start_cleanup_loop()

    app.register_blueprint(auth_bp)
    app.register_blueprint(kakao_bp)
    app.register_blueprint(client_bp)
    app.register_blueprint(admin_bp)
    app.register_blueprint(iot_bp)
    app.register_blueprint(member_bp)
    app.register_blueprint(fcm_bp)
    app.register_blueprint(logs_bp)
    app.register_blueprint(admin_member_bp)
    app.register_blueprint(wellknown_bp)

    return app

if __name__ == "__main__":
    create_app().run(host="0.0.0.0", port=15895, debug=False, use_reloader=False)
