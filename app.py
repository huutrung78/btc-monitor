import os
"""
Panel Designer - Backend Flask
Chay: python app.py
Truy cap: http://127.0.0.1:8080
"""
import os, json, base64, traceback, sqlite3, uuid
from pathlib import Path
from datetime import datetime, timedelta
from functools import wraps
from flask import Flask, render_template, request, jsonify, send_from_directory, redirect, url_for, session, g
from flask_cors import CORS
import anthropic
import bcrypt
from dotenv import load_dotenv

load_dotenv()  # đọc từ .env

# ── CONFIG ────────────────────────────────────────────────────────────────────
BASE   = Path(__file__).parent
DATA   = BASE / "data"
UPLOAD = BASE / "uploads"
OUTPUT = BASE / "outputs"
DB_PATH = BASE / "data" / "users.db"
for d in [DATA, UPLOAD, OUTPUT]:
    d.mkdir(exist_ok=True)

ADMIN_EMAIL    = os.getenv("ADMIN_EMAIL", "admin@paneldesigner.com")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "admin123")
NEW_USER_TOKENS = 1_000_000
TOKEN_BASE      = 1_000
TOKEN_PER_DEV   = 250

app = Flask(__name__, template_folder="templates", static_folder="static")
app.secret_key = os.getenv("SECRET_KEY", "dev-secret-change-in-production")
CORS(app)
app.config["MAX_CONTENT_LENGTH"] = 30 * 1024 * 1024  # 30MB

# ── ANTHROPIC CLIENT ──────────────────────────────────────────────────────────
client = anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))

# ── DATABASE ──────────────────────────────────────────────────────────────────
def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(str(DB_PATH))
        g.db.row_factory = sqlite3.Row
    return g.db

def init_db():
    db = sqlite3.connect(str(DB_PATH))
    db.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            email      TEXT    UNIQUE NOT NULL,
            phone      TEXT,
            password   TEXT    NOT NULL,
            tokens     INTEGER DEFAULT 1000000,
            is_admin   INTEGER DEFAULT 0,
            is_active  INTEGER DEFAULT 1,
            created_at TEXT    DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS token_log (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id      INTEGER NOT NULL,
            cost         INTEGER NOT NULL,
            panel_name   TEXT,
            device_count INTEGER,
            tokens_after INTEGER,
            created_at   TEXT DEFAULT (datetime('now')),
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
    """)
    # Tạo admin nếu chưa có
    existing = db.execute("SELECT id FROM users WHERE email=?", (ADMIN_EMAIL,)).fetchone()
    if not existing:
        pw_hash = bcrypt.hashpw(ADMIN_PASSWORD.encode(), bcrypt.gensalt()).decode()
        db.execute(
            "INSERT INTO users (email, phone, password, tokens, is_admin) VALUES (?,?,?,?,1)",
            (ADMIN_EMAIL, "", pw_hash, 2_000_000_000)
        )
        db.commit()
        print(f"  Admin created: {ADMIN_EMAIL}")
    db.close()

@app.teardown_appcontext
def close_db(e=None):
    db = g.pop("db", None)
    if db: db.close()

# ── AUTH HELPERS ──────────────────────────────────────────────────────────────
def get_current_user():
    user_id = session.get("user_id")
    if not user_id:
        return None
    return get_db().execute("SELECT * FROM users WHERE id=? AND is_active=1", (user_id,)).fetchone()

def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get("user_id"):
            if request.is_json:
                return jsonify({"ok": False, "error": "Chưa đăng nhập", "code": 401}), 401
            return redirect(url_for("login_page"))
        return f(*args, **kwargs)
    return decorated

def admin_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        user = get_current_user()
        if not user or not user["is_admin"]:
            return jsonify({"ok": False, "error": "Không có quyền"}), 403
        return f(*args, **kwargs)
    return decorated

# ── ROUTES ────────────────────────────────────────────────────────────────────
@app.route("/")
def index():
    user = get_current_user()
    if not user:
        return redirect(url_for("login_page"))
    return render_template("index.html", user=user)

# ── AUTH ROUTES ───────────────────────────────────────────────────────────────
@app.route("/login")
def login_page():
    if session.get("user_id"):
        return redirect(url_for("index"))
    return render_template("login.html")

@app.route("/register")
def register_page():
    if session.get("user_id"):
        return redirect(url_for("index"))
    return render_template("register.html")

@app.route("/api/auth/register", methods=["POST"])
def auth_register():
    body    = request.get_json()
    email   = (body.get("email") or "").strip().lower()
    phone   = (body.get("phone") or "").strip()
    password = body.get("password") or ""
    if not email or not password:
        return jsonify({"ok": False, "error": "Email và mật khẩu bắt buộc"}), 400
    if len(password) < 6:
        return jsonify({"ok": False, "error": "Mật khẩu tối thiểu 6 ký tự"}), 400
    db = get_db()
    if db.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone():
        return jsonify({"ok": False, "error": "Email đã tồn tại"}), 409
    pw_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
    db.execute(
        "INSERT INTO users (email, phone, password, tokens) VALUES (?,?,?,?)",
        (email, phone, pw_hash, NEW_USER_TOKENS)
    )
    db.commit()
    return jsonify({"ok": True, "message": f"Đăng ký thành công! Bạn có {NEW_USER_TOKENS:,} token."})

@app.route("/api/auth/login", methods=["POST"])
def auth_login():
    body     = request.get_json()
    email    = (body.get("email") or "").strip().lower()
    password = (body.get("password") or "").encode()
    db = get_db()
    user = db.execute("SELECT * FROM users WHERE email=? AND is_active=1", (email,)).fetchone()
    if not user or not bcrypt.checkpw(password, user["password"].encode()):
        return jsonify({"ok": False, "error": "Email hoặc mật khẩu không đúng"}), 401
    session.permanent = True
    app.permanent_session_lifetime = timedelta(days=30)
    session["user_id"] = user["id"]
    return jsonify({"ok": True, "email": user["email"], "tokens": user["tokens"], "is_admin": bool(user["is_admin"])})

@app.route("/api/auth/logout", methods=["POST"])
def auth_logout():
    session.clear()
    return jsonify({"ok": True})

@app.route("/api/me")
@login_required
def api_me():
    user = get_current_user()
    return jsonify({"ok": True, "email": user["email"], "phone": user["phone"],
                    "tokens": user["tokens"], "is_admin": bool(user["is_admin"]),
                    "created_at": user["created_at"]})

# ── ADMIN ROUTES ──────────────────────────────────────────────────────────────
@app.route("/admin")
@login_required
@admin_required
def admin_page():
    return render_template("admin.html")

@app.route("/api/admin/users")
@login_required
@admin_required
def admin_users():
    db = get_db()
    users = db.execute("SELECT id, email, phone, tokens, is_admin, is_active, created_at FROM users ORDER BY created_at DESC").fetchall()
    return jsonify({"ok": True, "users": [dict(u) for u in users]})

@app.route("/api/admin/add-tokens", methods=["POST"])
@login_required
@admin_required
def admin_add_tokens():
    body    = request.get_json()
    user_id = body.get("user_id")
    amount  = int(body.get("amount", 0))
    if not user_id or amount <= 0:
        return jsonify({"ok": False, "error": "user_id và amount bắt buộc"}), 400
    db = get_db()
    db.execute("UPDATE users SET tokens = tokens + ? WHERE id=?", (amount, user_id))
    db.commit()
    updated = db.execute("SELECT tokens FROM users WHERE id=?", (user_id,)).fetchone()
    return jsonify({"ok": True, "tokens_new": updated["tokens"]})

@app.route("/api/admin/toggle-user", methods=["POST"])
@login_required
@admin_required
def admin_toggle_user():
    body    = request.get_json()
    user_id = body.get("user_id")
    db = get_db()
    db.execute("UPDATE users SET is_active = 1 - is_active WHERE id=? AND is_admin=0", (user_id,))
    db.commit()
    return jsonify({"ok": True})

@app.route("/no-tokens")
def no_tokens_page():
    return render_template("no_tokens.html")

@app.route("/api/analyze", methods=["POST"])
@login_required
def analyze():
    """Nhận file ảnh/PDF, gọi Claude Vision, trả về JSON thiết bị."""
    try:
        # Kiểm tra token trước khi gọi AI
        user = get_current_user()
        if user["tokens"] < TOKEN_BASE:
            return jsonify({"ok": False, "error": "Hết token", "code": "no_tokens"}), 402

        file      = request.files.get("file")
        extra_ctx = request.form.get("context", "")

        if not file:
            return jsonify({"ok": False, "error": "Không có file"}), 400

        # Lấy tên tủ từ tên file (bỏ đuôi mở rộng)
        enc_name  = Path(file.filename).stem if file.filename else request.form.get("panel_name", "Panel")

        if not file:
            return jsonify({"ok": False, "error": "Không có file"}), 400

        ext  = file.filename.rsplit(".", 1)[-1].lower()
        data = file.read()
        b64  = base64.standard_b64encode(data).decode()

        if ext == "dxf":
            # Render DXF → PNG 3000px rồi gửi AI
            try:
                import ezdxf
                from ezdxf.addons.drawing import RenderContext, Frontend
                from ezdxf.addons.drawing.matplotlib import MatplotlibBackend
                import matplotlib.pyplot as plt
                import io, tempfile, os
                tmp = tempfile.NamedTemporaryFile(suffix=".dxf", delete=False)
                tmp.write(data); tmp.flush(); tmp.close()
                doc = ezdxf.readfile(tmp.name)
                msp = doc.modelspace()
                fig = plt.figure(figsize=(20, 20), dpi=150)
                ax = fig.add_axes([0, 0, 1, 1])
                ctx = RenderContext(doc)
                out = MatplotlibBackend(ax)
                Frontend(ctx, out).draw_layout(msp, finalize=True)
                buf = io.BytesIO()
                fig.savefig(buf, format="png", bbox_inches="tight", facecolor="white", dpi=150)
                plt.close(fig); buf.seek(0)
                data = buf.read()
                b64 = base64.standard_b64encode(data).decode()
                os.unlink(tmp.name)
            except Exception as e:
                return jsonify({"ok": False, "error": f"Lỗi render DXF: {e}"}), 500
            media = "image/png"
            content_block = {"type": "image", "source": {"type": "base64", "media_type": media, "data": b64}}
        elif ext in ("jpg", "jpeg"):
            media = "image/jpeg"
            content_block = {"type": "image", "source": {"type": "base64", "media_type": media, "data": b64}}
        elif ext == "png":
            media = "image/png"
            content_block = {"type": "image", "source": {"type": "base64", "media_type": media, "data": b64}}
        elif ext == "pdf":
            media = "application/pdf"
            content_block = {"type": "document", "source": {"type": "base64", "media_type": media, "data": b64}}
        else:
            return jsonify({"ok": False, "error": f"Định dạng {ext} chưa hỗ trợ. Dùng DXF/JPG/PNG/PDF."}), 400

        prompt = build_prompt(enc_name, extra_ctx)

        resp = client.messages.create(
            model="claude-sonnet-4-5",
            max_tokens=4000,
            messages=[{"role": "user", "content": [content_block, {"type": "text", "text": prompt}]}]
        )
        raw_text = "".join(b.text for b in resp.content if hasattr(b, "text"))
        result   = parse_json_response(raw_text)

        # Lưu upload
        save_path = UPLOAD / f"{enc_name}_{file.filename}"
        with open(save_path, "wb") as f:
            f.write(data)

        # Trừ token sau khi có kết quả (admin không bị trừ)
        device_count = len(result.get("devices", []))
        cost = TOKEN_BASE + device_count * TOKEN_PER_DEV
        db = get_db()
        if not user["is_admin"]:
            db.execute("UPDATE users SET tokens = MAX(0, tokens - ?) WHERE id=?", (cost, user["id"]))
        db.execute(
            "INSERT INTO token_log (user_id, cost, panel_name, device_count, tokens_after) VALUES (?,?,?,?,?)",
            (user["id"], cost, enc_name, device_count,
             db.execute("SELECT tokens FROM users WHERE id=?", (user["id"],)).fetchone()["tokens"])
        )
        db.commit()
        tokens_left = db.execute("SELECT tokens FROM users WHERE id=?", (user["id"],)).fetchone()["tokens"]

        return jsonify({"ok": True, "raw": raw_text, **result,
                        "tokens_used": cost, "tokens_left": tokens_left})

    except anthropic.APIConnectionError:
        return jsonify({"ok": False, "error": "Không kết nối được Anthropic API. Kiểm tra ANTHROPIC_API_KEY."}), 503
    except anthropic.AuthenticationError:
        return jsonify({"ok": False, "error": "API Key không hợp lệ. Đặt biến ANTHROPIC_API_KEY."}), 401
    except Exception as e:
        traceback.print_exc()
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/library", methods=["GET"])
def get_library():
    """Trả về database thiết bị theo hãng."""
    brand = request.args.get("brand", "ls")
    path  = DATA / f"db_{brand}.json"
    if path.exists():
        with open(path, encoding="utf-8") as f:
            return jsonify(json.load(f))
    # fallback: trả về rỗng
    return jsonify({"brand": brand, "devices": []})


@app.route("/api/library", methods=["POST"])
def save_library():
    """Lưu thiết bị mới vào database."""
    body  = request.get_json()
    brand = body.get("brand", "ls")
    path  = DATA / f"db_{brand}.json"
    db    = {"brand": brand, "devices": []}
    if path.exists():
        with open(path, encoding="utf-8") as f:
            db = json.load(f)
    db["devices"].append(body.get("device", {}))
    with open(path, "w", encoding="utf-8") as f:
        json.dump(db, f, ensure_ascii=False, indent=2)
    return jsonify({"ok": True, "total": len(db["devices"])})


@app.route("/api/library/<brand>/<ma_sp>", methods=["DELETE"])
def delete_device(brand, ma_sp):
    path = DATA / f"db_{brand}.json"
    if not path.exists():
        return jsonify({"ok": False}), 404
    with open(path, encoding="utf-8") as f:
        db = json.load(f)
    db["devices"] = [d for d in db["devices"] if d.get("ma") != ma_sp]
    with open(path, "w", encoding="utf-8") as f:
        json.dump(db, f, ensure_ascii=False, indent=2)
    return jsonify({"ok": True})


@app.route("/api/render-dxf", methods=["POST"])
def render_dxf():
    """Nhận file DXF, render thành PNG 2000px, trả về base64 để gửi cho AI."""
    try:
        import ezdxf
        from ezdxf.addons.drawing import RenderContext, Frontend
        from ezdxf.addons.drawing.matplotlib import MatplotlibBackend
        import matplotlib.pyplot as plt
        import io

        file = request.files.get("file")
        if not file:
            return jsonify({"ok": False, "error": "Không có file DXF"}), 400

        # Đọc DXF từ bộ nhớ
        dxf_data = file.read()
        tmp_path = UPLOAD / f"tmp_{file.filename}"
        with open(tmp_path, "wb") as f:
            f.write(dxf_data)

        doc = ezdxf.readfile(str(tmp_path))
        msp = doc.modelspace()

        # Render bằng matplotlib
        fig = plt.figure(figsize=(20, 20), dpi=150)  # 3000px
        ax = fig.add_axes([0, 0, 1, 1])
        ctx = RenderContext(doc)
        out = MatplotlibBackend(ax)
        Frontend(ctx, out).draw_layout(msp, finalize=True)

        # Xuất PNG vào bộ nhớ
        buf = io.BytesIO()
        fig.savefig(buf, format="png", bbox_inches="tight",
                    facecolor="white", dpi=150)
        plt.close(fig)
        buf.seek(0)
        png_bytes = buf.read()

        # Lưu file PNG
        stem = Path(file.filename).stem
        png_path = UPLOAD / f"{stem}_rendered.png"
        with open(png_path, "wb") as f:
            f.write(png_bytes)

        # Trả về base64 để frontend gửi thẳng cho /api/analyze
        b64 = base64.standard_b64encode(png_bytes).decode()
        tmp_path.unlink(missing_ok=True)

        return jsonify({
            "ok": True,
            "png_b64": b64,
            "png_filename": f"{stem}_rendered.png",
            "size_kb": len(png_bytes) // 1024
        })

    except Exception as e:
        traceback.print_exc()
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/export/dxf", methods=["POST"])
def export_dxf():
    """Sinh file DXF từ layout data."""
    body     = request.get_json()
    layout   = body.get("layout", {})
    dxf_text = generate_dxf(layout)
    name     = body.get("name", "panel")
    out_path = OUTPUT / f"{name}_layout.dxf"
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(dxf_text)
    # trả về nội dung để browser download
    return dxf_text, 200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": f'attachment; filename="{name}_layout.dxf"'
    }


@app.route("/api/export/excel", methods=["POST"])
def export_excel():
    """Xuất file Excel bảng kê vật tư, tên file = tên tủ."""
    try:
        import openpyxl
        from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
        from openpyxl.utils import get_column_letter
    except ImportError:
        return jsonify({"ok": False, "error": "Thiếu thư viện openpyxl. Chạy: pip install openpyxl"}), 500

    body     = request.get_json()
    devices  = body.get("devices", [])
    panel    = body.get("panel", {})
    name     = body.get("name", "panel")
    discount = float(body.get("discount", 0))   # % chiết khấu, VD: 30 → 30%
    # Nếu client gửi bom_input/bom_output đã match sẵn → dùng luôn
    _bom_input  = body.get("bom_input",  None)
    _bom_output = body.get("bom_output", None)

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Bảng Kê Vật Tư"

    yellow  = PatternFill("solid", start_color="FFFF00")
    green   = PatternFill("solid", start_color="E2EFDA")
    orange  = PatternFill("solid", start_color="FCE4D6")
    thin    = Side(style="thin", color="000000")
    bdr     = Border(left=thin, right=thin, top=thin, bottom=thin)
    bold    = Font(name="Arial", bold=True, size=10)
    normal  = Font(name="Arial", size=10)
    red_bold= Font(name="Arial", bold=True, size=10, color="C00000")
    center  = Alignment(wrap_text=True, vertical="center", horizontal="center")
    left    = Alignment(wrap_text=True, vertical="center", horizontal="left")
    right   = Alignment(wrap_text=True, vertical="center", horizontal="right")
    num_fmt = '#,##0'

    # ── Dòng 1: Chiết khấu header ──
    ws.merge_cells("H1:I1")
    c = ws.cell(row=1, column=8, value="chiết khấu")
    c.font = bold; c.alignment = center; c.border = bdr
    c = ws.cell(row=1, column=10, value=discount/100)
    c.font = red_bold; c.number_format = '0%'; c.alignment = center; c.border = bdr
    ws.row_dimensions[1].height = 16

    # ── Dòng 2: Header chính ──
    headers    = ["STT",
                  f"Tên Thiết Bị : {name} ( Tên này lấy trong bản vẽ)",
                  "Model", "Mã SP", "HÃNG SẢN XUẤT", "Đơn vị", "SL",
                  "Giá gốc", "Giá mua\nthực", "Thành tiền"]
    col_widths = [6, 55, 25, 18, 16, 10, 6, 14, 14, 16]

    for col, (h, w) in enumerate(zip(headers, col_widths), 1):
        c = ws.cell(row=2, column=col, value=h)
        c.font = bold; c.fill = yellow; c.border = bdr; c.alignment = center
        ws.column_dimensions[get_column_letter(col)].width = w
    ws.row_dimensions[2].height = 28

    # Fill màu cam cho ô không rõ dữ liệu
    orange_font = Font(name="Arial", size=10, color="C55A11", italic=True)

    def apply_uncertain(cell, value, confidence, note=""):
        """Tô màu cam + ghi 'Không rõ dữ liệu' nếu confidence thấp hoặc value rỗng."""
        is_uncertain = (
            confidence in ("low", "medium") or
            value is None or
            (isinstance(value, str) and value.strip() == "")
        )
        if is_uncertain:
            display = "Không rõ dữ liệu"
            if note:
                display += f" ({note})"
            cell.value = display
            cell.font  = orange_font
            cell.fill  = orange
        else:
            cell.value = value

    # ── Hàm viết section (dùng chung cho 1 tủ) ──
    def write_section_single(label, items, start_row, stt_start=1):
        r = start_row
        c = ws.cell(row=r, column=2, value=label)
        c.font = bold; c.fill = green; c.border = bdr; c.alignment = left
        for col in [1,3,4,5,6,7,8,9,10]:
            ws.cell(row=r, column=col).border = bdr
            ws.cell(row=r, column=col).fill = green
        r += 1
        price_rows = []
        thanh_tien_list = []
        stt = stt_start
        for d in items:
            conf = d.get("confidence", "high")
            note = d.get("note", "")

            if d.get("_bom"):
                ten     = d.get("ten", "")
                model   = d.get("model", "")
                ma_sp   = d.get("ma_sp", "")
                hang    = d.get("hang", "")
                sl      = d.get("sl", 1) or 1
                don_gia = d.get("don_gia") if d.get("don_gia") not in (None, 0, "") else None
            else:
                # Xây tên thiết bị — từng field riêng để kiểm tra confidence
                in_val  = d.get("in")
                poles   = d.get("poles", "")
                dev_type = d.get("type", "")
                ten = f"{dev_type} {poles}P"
                if in_val is not None:
                    ten += f" {in_val}A"
                if d.get("icu"):  ten += f" {d.get('icu')}kA"
                if d.get("idelta"): ten += f" {d.get('idelta')}mA"
                ma_sp   = d.get("ma_sp", "")
                model   = d.get("model", "")
                hang    = d.get("hang", "")
                sl      = d.get("sl", 1) or 1
                don_gia = d.get("don_gia") if d.get("don_gia") not in (None, 0, "") else None

            # Cột STT
            ws.cell(row=r, column=1, value=stt).font = normal
            ws.cell(row=r, column=1).border = bdr
            ws.cell(row=r, column=1).alignment = center

            # Cột Tên thiết bị (col 2) — màu cam nếu low/medium
            c2 = ws.cell(row=r, column=2)
            c2.border = bdr; c2.alignment = left
            apply_uncertain(c2, ten.strip() or None, conf, note)
            if conf == "high" and ten.strip():
                c2.font = normal

            # Cột Model (col 3)
            c3 = ws.cell(row=r, column=3)
            c3.border = bdr; c3.alignment = center
            apply_uncertain(c3, model or None, conf, "")
            if conf == "high" and model:
                c3.font = normal

            # Cột Mã SP (col 4)
            c4 = ws.cell(row=r, column=4)
            c4.border = bdr; c4.alignment = center
            apply_uncertain(c4, ma_sp or None, conf, "")
            if conf == "high" and ma_sp:
                c4.font = normal

            # Cột Hãng (col 5), Đơn vị (col 6), SL (col 7) — ít nhạy cảm hơn
            ws.cell(row=r, column=5, value=hang).font = normal
            ws.cell(row=r, column=5).border = bdr; ws.cell(row=r, column=5).alignment = center
            ws.cell(row=r, column=6, value="Cái").font = normal
            ws.cell(row=r, column=6).border = bdr; ws.cell(row=r, column=6).alignment = center
            ws.cell(row=r, column=7, value=sl).font = normal
            ws.cell(row=r, column=7).border = bdr; ws.cell(row=r, column=7).alignment = center

            # Cột Giá gốc (col 8) — ghi 0 nếu không có giá, tô cam để báo hiệu
            c8 = ws.cell(row=r, column=8)
            c8.border = bdr; c8.alignment = right; c8.number_format = num_fmt
            if don_gia:
                c8.value = don_gia; c8.font = normal
            else:
                c8.value = 0; c8.font = orange_font; c8.fill = orange  # số 0, không phải text

            # Giá mua thực (col 9) — tính sẵn, không dùng công thức
            ck = discount / 100 if discount else 0
            gia_mua = round(don_gia * (1 - ck)) if don_gia else 0
            c9 = ws.cell(row=r, column=9, value=gia_mua if gia_mua else 0)
            c9.font = normal; c9.border = bdr; c9.alignment = right; c9.number_format = num_fmt
            if not don_gia: c9.fill = orange

            # Thành tiền (col 10) — tính sẵn
            sl_val = d.get("sl", 1) or 1
            thanh_tien = gia_mua * sl_val if gia_mua else 0
            c10 = ws.cell(row=r, column=10, value=thanh_tien)
            c10.font = normal; c10.border = bdr; c10.alignment = right; c10.number_format = num_fmt
            if not don_gia: c10.fill = orange

            price_rows.append(r)
            thanh_tien_list.append(thanh_tien)
            ws.row_dimensions[r].height = 18
            r += 1; stt += 1
        return r, price_rows, stt, thanh_tien_list

    if _bom_input is not None and _bom_output is not None:
        # Dùng BOM đã match từ client (có model/mã/giá)
        def bom_to_dev(b):
            return {"type": b.get("ten",""), "poles":"", "in":"", "icu":None, "idelta":None,
                    "model": b.get("model",""), "ma_sp": b.get("ma_sp",""),
                    "hang": b.get("hang",""), "sl": b.get("sl",1), "don_gia": b.get("don_gia",0)}
        inp = [dict(**b, **{"_bom":True}) for b in _bom_input]
        out = [dict(**b, **{"_bom":True}) for b in _bom_output]
    else:
        inp = [d for d in devices if d.get("level", 0) == 0]
        out = [d for d in devices if d.get("level", 0) >  0]

    all_price_rows = []
    all_thanh_tien = []  # track giá trị thực để tính tổng
    stt = 1
    row, pr, stt, tt = write_section_single("Đầu vào:", inp, 3, stt)
    all_price_rows += pr; all_thanh_tien += tt
    row, pr, stt, tt = write_section_single("Đầu ra:", out, row, stt)
    all_price_rows += pr; all_thanh_tien += tt

    # Vật tư phụ
    for label in ["Thanh cái đồng", "Vật tư phụ", "Nhân công đấu nối tại xưởng"]:
        for col in range(1, 11):
            ws.cell(row=row, column=col).border = bdr
        ws.cell(row=row, column=2, value=label).alignment = left
        ws.cell(row=row, column=2).font = normal; ws.cell(row=row, column=2).border = bdr
        ws.cell(row=row, column=6, value="Tủ").alignment = center
        ws.cell(row=row, column=7, value=1).alignment = center
        c = ws.cell(row=row, column=9, value=0)
        c.font = normal; c.border = bdr; c.alignment = right; c.number_format = num_fmt
        c = ws.cell(row=row, column=10, value=0)
        c.font = normal; c.border = bdr; c.alignment = right; c.number_format = num_fmt
        all_price_rows.append(row); row += 1

    # Tổng
    c = ws.cell(row=row, column=2, value="Tổng")
    c.font = bold; c.fill = yellow; c.border = bdr; c.alignment = center
    for col in [1,3,4,5,6,7,8,9]:
        ws.cell(row=row, column=col).border = bdr
        ws.cell(row=row, column=col).fill = yellow
    total_val = sum(all_thanh_tien) if all_thanh_tien else 0
    c = ws.cell(row=row, column=10, value=total_val)
    c.font = bold; c.fill = yellow; c.border = bdr; c.alignment = right; c.number_format = num_fmt

    # Freeze header
    ws.freeze_panes = "A3"

    out_path = OUTPUT / f"{name}.xlsx"
    wb.save(out_path)
    with open(out_path, "rb") as f:
        content = f.read()

    from urllib.parse import quote
    safe_name = quote(f"{name}.xlsx", safe='')
    return content, 200, {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": f"attachment; filename*=UTF-8''{safe_name}"
    }


@app.route("/api/parse-dxf", methods=["POST"])
def parse_dxf():
    """Đọc file DXF, tự động phát hiện và tách từng tủ theo tọa độ X."""
    try:
        import ezdxf, re
        file = request.files.get("file")
        if not file:
            return jsonify({"ok": False, "error": "Không có file"}), 400

        data = file.read()
        tmp = UPLOAD / f"tmp_{file.filename}"
        tmp.write_bytes(data)

        doc = ezdxf.readfile(str(tmp))
        msp = doc.modelspace()

        # Thu thập tất cả TEXT entities có tọa độ
        texts = []
        for e in msp:
            if e.dxftype() == "TEXT":
                try:
                    txt = e.dxf.text.strip()
                    x, y = e.dxf.insert.x, e.dxf.insert.y
                    if txt and not txt.startswith("\\M"):
                        texts.append({"x": x, "y": y, "text": txt})
                except:
                    pass

        # Tìm tên tủ (pattern: 1AP-xxx, 2AP-xxx, DB-xxx, MSB...)
        panel_pattern = re.compile(r'^(\d+AP-\w+|DB\w*|MSB\w*|TU\w*)$', re.IGNORECASE)
        panel_anchors = []
        for t in texts:
            if panel_pattern.match(t["text"]):
                panel_anchors.append(t)

        if not panel_anchors:
            tmp.unlink(missing_ok=True)
            return jsonify({"ok": False, "error": "Không tìm thấy tên tủ trong file DXF"}), 400

        # Sắp xếp tủ theo X
        panel_anchors.sort(key=lambda p: p["x"])

        # Loại bỏ duplicate tên tủ (giữ lại 1 anchor mỗi tên)
        seen = {}
        for p in panel_anchors:
            name = p["text"]
            if name not in seen:
                seen[name] = p
        unique_panels = sorted(seen.values(), key=lambda p: p["x"])

        # Xác định vùng X cho mỗi tủ
        panels = []
        for i, p in enumerate(unique_panels):
            x_start = p["x"] - 2000
            x_end   = unique_panels[i+1]["x"] - 2000 if i+1 < len(unique_panels) else p["x"] + 50000
            panels.append({
                "name": p["text"],
                "x_start": x_start,
                "x_end": x_end,
                "anchor_x": p["x"],
                "anchor_y": p["y"],
            })

        # Gán text vào từng tủ theo vùng X
        for panel in panels:
            panel_texts = [
                t for t in texts
                if panel["x_start"] <= t["x"] < panel["x_end"]
            ]
            # Trích xuất thông số chính
            devices_raw = []
            cb_types = re.compile(r'(MCCB|MCB|RCBO|RCCB|ELCB|ACB|Contactor)', re.IGNORECASE)
            current_cb = None
            for t in sorted(panel_texts, key=lambda v: -v["y"]):
                txt = t["text"]
                if cb_types.search(txt):
                    current_cb = {"type_raw": txt, "x": t["x"], "y": t["y"], "attrs": []}
                    devices_raw.append(current_cb)
                elif current_cb and abs(t["x"] - current_cb["x"]) < 15000:
                    current_cb["attrs"].append(txt)

            # Tìm thông số tủ
            pe = next((t["text"] for t in panel_texts if t["text"].startswith("Pe=")), "")
            ijs = next((t["text"] for t in panel_texts if t["text"].startswith("Ijs=")), "")
            cos = next((t["text"] for t in panel_texts if "COS" in t["text"]), "")

            panel["text_count"] = len(panel_texts)
            panel["device_count"] = len(devices_raw)
            panel["pe"] = pe
            panel["ijs"] = ijs
            panel["cos"] = cos
            panel["devices_raw"] = devices_raw[:30]  # giới hạn 30

        tmp.unlink(missing_ok=True)
        return jsonify({
            "ok": True,
            "panel_count": len(panels),
            "panels": panels
        })

    except Exception as e:
        traceback.print_exc()
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/analyze-dxf-panels", methods=["POST"])
def analyze_dxf_panels():
    """Render DXF 1 lan, crop tung tu, goi AI song song 3 tu cung luc."""
    try:
        import ezdxf, re, io
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        from ezdxf.addons.drawing import RenderContext, Frontend
        from ezdxf.addons.drawing.matplotlib import MatplotlibBackend
        from concurrent.futures import ThreadPoolExecutor, as_completed

        file = request.files.get("file")
        if not file:
            return jsonify({"ok": False, "error": "Khong co file"}), 400

        data = file.read()
        stem = Path(file.filename).stem
        tmp  = UPLOAD / ("tmp_" + file.filename)
        tmp.write_bytes(data)

        doc = ezdxf.readfile(str(tmp))
        msp = doc.modelspace()

        texts = []
        for e in msp:
            if e.dxftype() == "TEXT":
                try:
                    txt = e.dxf.text.strip()
                    x, y = e.dxf.insert.x, e.dxf.insert.y
                    if txt and not txt.startswith("\\M"):
                        texts.append((x, y, txt))
                except:
                    pass

        panel_pattern = re.compile(r"^(\d+AP-\w+|DB\w*|MSB\w*)$", re.IGNORECASE)
        seen = {}
        for x, y, txt in texts:
            if panel_pattern.match(txt) and txt not in seen:
                seen[txt] = x
        unique_panels = sorted(seen.items(), key=lambda p: p[1])

        if not unique_panels:
            tmp.unlink(missing_ok=True)
            return jsonify({"ok": False, "error": "Khong tim thay tu nao trong DXF"}), 400

        all_y = [y for x, y, t in texts]
        y_min = min(all_y) - 5000
        y_max = max(all_y) + 5000

        # Tính boundary X cho từng tủ dựa trên tọa độ text thực tế
        panel_boundaries = []
        for i, (panel_name, px) in enumerate(unique_panels):
            x_start = px - 3000
            if i + 1 < len(unique_panels):
                x_end = unique_panels[i+1][1] - 1000
            else:
                panel_texts_x = [x for x, y, t in texts if x >= px - 3000]
                x_end = max(panel_texts_x) + 5000 if panel_texts_x else px + 30000
            panel_boundaries.append((x_start, x_end))

        # Render riêng từng tủ — mỗi figure độc lập, AI chỉ thấy 1 tủ
        print(f"[DXF] Render rieng {len(unique_panels)} tu...")
        ctx = RenderContext(doc)
        panel_images = {}
        for i, (panel_name, px) in enumerate(unique_panels):
            x_start, x_end = panel_boundaries[i]
            fig, ax = plt.subplots(figsize=(20, 20))
            ax.set_facecolor("white")
            fig.patch.set_facecolor("white")
            out = MatplotlibBackend(ax)
            Frontend(ctx, out).draw_layout(msp, finalize=True)
            ax.axis("off")
            ax.set_xlim(x_start, x_end)
            ax.set_ylim(y_min, y_max)
            buf = io.BytesIO()
            fig.savefig(buf, format="png", bbox_inches="tight", facecolor="white", dpi=150)
            plt.close(fig)
            buf.seek(0)
            png_bytes = buf.read()
            (UPLOAD / (stem + "_" + panel_name + ".png")).write_bytes(png_bytes)
            panel_images[panel_name] = base64.standard_b64encode(png_bytes).decode()
            print(f"[DXF] Render: {panel_name} ({len(png_bytes)//1024}KB)")

        tmp.unlink(missing_ok=True)

        def analyze_one(panel_name):
            b64 = panel_images[panel_name]
            try:
                prompt = build_prompt(panel_name)
                resp = client.messages.create(
                    model="claude-sonnet-4-5",
                    max_tokens=4000,
                    messages=[{"role": "user", "content": [
                        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": b64}},
                        {"type": "text", "text": prompt}
                    ]}]
                )
                raw    = "".join(b.text for b in resp.content if hasattr(b, "text"))
                parsed = parse_json_response(raw)
                print(f"[AI] OK: {panel_name} -> {len(parsed.get('devices', []))} thiet bi")
                return {"panel_name": panel_name, "ok": True,
                        "devices": parsed.get("devices", []),
                        "panel":   parsed.get("panel",   {}),
                        "png_b64": b64}
            except Exception as e:
                print(f"[AI] ERR: {panel_name} -> {e}")
                return {"panel_name": panel_name, "ok": False, "error": str(e),
                        "devices": [], "panel": {}, "png_b64": b64}

        results_map = {}
        panel_names = [p[0] for p in unique_panels]
        # Gọi tất cả tủ song song — không giới hạn batch size
        max_workers = min(len(panel_names), 10)
        print(f"[AI] Goi song song {len(panel_names)} tu, workers={max_workers}")
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {executor.submit(analyze_one, name): name for name in panel_names}
            for future in as_completed(futures, timeout=300):
                result = future.result()
                results_map[result["panel_name"]] = result
                print(f"[DONE] {result['panel_name']} ({'OK' if result['ok'] else 'ERR'})")

        results  = [results_map[n] for n in panel_names if n in results_map]
        ok_count = sum(1 for r in results if r["ok"])
        print(f"[DXF] Hoan thanh: {ok_count}/{len(results)} tu OK")

        return jsonify({"ok": True, "total_panels": len(results), "results": results})

    except Exception as e:
        traceback.print_exc()
        return jsonify({"ok": False, "error": str(e)}), 500

@app.route("/api/export-excel-multi", methods=["POST"])
def export_excel_multi():
    """Xuất 1 file Excel nhiều sheet — mỗi sheet 1 tủ, tên sheet = tên tủ."""
    try:
        import openpyxl
        from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
        from openpyxl.utils import get_column_letter
    except ImportError:
        return jsonify({"ok": False, "error": "Thiếu openpyxl"}), 500

    body     = request.get_json()
    panels   = body.get("panels", [])
    filename = body.get("filename", "BOM_ToanBo")
    discount = float(body.get("discount", 0))

    if not panels:
        return jsonify({"ok": False, "error": "Không có dữ liệu tủ"}), 400

    yellow     = PatternFill("solid", start_color="FFFF00")
    sum_yellow = PatternFill("solid", start_color="FFE699")
    green      = PatternFill("solid", start_color="E2EFDA")
    thin       = Side(style="thin", color="000000")
    bdr     = Border(left=thin, right=thin, top=thin, bottom=thin)
    bold    = Font(name="Arial", bold=True, size=10)
    normal  = Font(name="Arial", size=10)
    red_bold= Font(name="Arial", bold=True, size=10, color="C00000")
    center  = Alignment(wrap_text=True, vertical="center", horizontal="center")
    left    = Alignment(wrap_text=True, vertical="center", horizontal="left")
    right   = Alignment(wrap_text=True, vertical="center", horizontal="right")
    num_fmt = '#,##0'

    col_widths = [6, 55, 25, 18, 16, 10, 6, 14, 14, 16]

    orange_font = Font(name="Arial", size=10, color="C55A11", italic=True)
    orange      = PatternFill("solid", start_color="FCE4D6")

    def apply_uncertain_ws(ws, cell, value, confidence, note=""):
        is_uncertain = (
            confidence in ("low", "medium") or
            value is None or
            (isinstance(value, str) and value.strip() == "")
        )
        if is_uncertain:
            display = "Không rõ dữ liệu"
            if note:
                display += f" ({note})"
            cell.value = display
            cell.font  = orange_font
            cell.fill  = orange
        else:
            cell.value = value

    def write_panel_sheet(ws, name, bom_input, bom_output):
        ws.title = name[:31]

        # Dòng 1: Chiết khấu
        ws.merge_cells("H1:I1")
        c = ws.cell(row=1, column=8, value="chiết khấu")
        c.font = bold; c.alignment = center; c.border = bdr
        c = ws.cell(row=1, column=10, value=discount/100)
        c.font = red_bold; c.number_format = '0%'; c.alignment = center; c.border = bdr
        ws.row_dimensions[1].height = 16

        # Dòng 2: Header
        headers = ["STT", f"Tên Thiết Bị : {name} ( Tên này lấy trong bản vẽ)",
                   "Model", "Mã SP", "HÃNG SẢN XUẤT", "Đơn vị", "SL",
                   "Giá gốc", "Giá mua\nthực", "Thành tiền"]
        for col, (h, w) in enumerate(zip(headers, col_widths), 1):
            c = ws.cell(row=2, column=col, value=h)
            c.font = bold; c.fill = yellow; c.border = bdr; c.alignment = center
            ws.column_dimensions[get_column_letter(col)].width = w
        ws.row_dimensions[2].height = 28

        all_price_rows = []
        row = 3
        stt = 1

        for section_label, items in [("Đầu vào:", bom_input), ("Đầu ra:", bom_output)]:
            c = ws.cell(row=row, column=2, value=section_label)
            c.font = bold; c.fill = green; c.border = bdr; c.alignment = left
            for col in [1,3,4,5,6,7,8,9,10]:
                ws.cell(row=row, column=col).border = bdr
                ws.cell(row=row, column=col).fill = green
            row += 1

            for d in items:
                conf = d.get("confidence", "high")
                note = d.get("note", "")
                ten      = d.get("ten", "")
                model    = d.get("model", "")
                ma_sp    = d.get("ma_sp", "")
                hang     = d.get("hang", "")
                sl       = d.get("sl", 1) or 1
                don_gia  = d.get("don_gia") if d.get("don_gia") not in (None, 0, "") else None

                # STT
                ws.cell(row=row, column=1, value=stt).font = normal
                ws.cell(row=row, column=1).border = bdr
                ws.cell(row=row, column=1).alignment = center

                # Tên (col 2)
                c2 = ws.cell(row=row, column=2); c2.border = bdr; c2.alignment = left
                apply_uncertain_ws(ws, c2, ten.strip() or None, conf, note)
                if conf == "high" and ten.strip(): c2.font = normal

                # Model (col 3)
                c3 = ws.cell(row=row, column=3); c3.border = bdr; c3.alignment = center
                apply_uncertain_ws(ws, c3, model or None, conf, "")
                if conf == "high" and model: c3.font = normal

                # Mã SP (col 4)
                c4 = ws.cell(row=row, column=4); c4.border = bdr; c4.alignment = center
                apply_uncertain_ws(ws, c4, ma_sp or None, conf, "")
                if conf == "high" and ma_sp: c4.font = normal

                # Hãng / Đơn vị / SL
                ws.cell(row=row, column=5, value=hang).font = normal
                ws.cell(row=row, column=5).border = bdr; ws.cell(row=row, column=5).alignment = center
                ws.cell(row=row, column=6, value="Cái").font = normal
                ws.cell(row=row, column=6).border = bdr; ws.cell(row=row, column=6).alignment = center
                ws.cell(row=row, column=7, value=sl).font = normal
                ws.cell(row=row, column=7).border = bdr; ws.cell(row=row, column=7).alignment = center

                # Giá gốc (col 8) — ghi 0 nếu không có giá, tô cam để báo hiệu
                c8 = ws.cell(row=row, column=8)
                c8.border = bdr; c8.alignment = right; c8.number_format = num_fmt
                if don_gia:
                    c8.value = don_gia; c8.font = normal
                else:
                    c8.value = 0; c8.font = orange_font; c8.fill = orange

                ck2 = discount / 100 if discount else 0
                gia_mua2 = round(don_gia * (1 - ck2)) if don_gia else 0
                c = ws.cell(row=row, column=9, value=gia_mua2 if gia_mua2 else 0)
                c.font = normal; c.border = bdr; c.alignment = right; c.number_format = num_fmt
                if not don_gia: c.fill = orange
                sl_val2 = d.get("sl", 1) or 1
                thanh_tien2 = gia_mua2 * sl_val2 if gia_mua2 else 0
                c = ws.cell(row=row, column=10, value=thanh_tien2)
                c.font = normal; c.border = bdr; c.alignment = right; c.number_format = num_fmt
                if not don_gia: c.fill = orange
                all_price_rows.append(row)
                ws.row_dimensions[row].height = 18
                row += 1; stt += 1

        # Vật tư phụ
        for label in ["Thanh cái đồng", "Vật tư phụ", "Nhân công đấu nối tại xưởng"]:
            for col in range(1, 11):
                ws.cell(row=row, column=col).border = bdr
            c = ws.cell(row=row, column=2, value=label)
            c.font = normal; c.border = bdr; c.alignment = left
            ws.cell(row=row, column=6, value="Tủ").alignment = center
            ws.cell(row=row, column=7, value=1).alignment = center
            c = ws.cell(row=row, column=9, value=f"=H{row}*(1-$J$1)")
            c.font = normal; c.border = bdr; c.alignment = right; c.number_format = num_fmt
            c = ws.cell(row=row, column=10, value=f"=G{row}*I{row}")
            c.font = normal; c.border = bdr; c.alignment = right; c.number_format = num_fmt
            all_price_rows.append(row); row += 1

        # Tổng
        c = ws.cell(row=row, column=2, value="Tổng")
        c.font = bold; c.fill = yellow; c.border = bdr; c.alignment = center
        for col in [1,3,4,5,6,7,8,9]:
            ws.cell(row=row, column=col).border = bdr
            ws.cell(row=row, column=col).fill = yellow
        refs = "+".join([f"J{r}" for r in all_price_rows]) if all_price_rows else "0"
        c = ws.cell(row=row, column=10, value=f"={refs}")
        c.font = bold; c.fill = yellow; c.border = bdr; c.alignment = right; c.number_format = num_fmt
        ws.freeze_panes = "A3"
        return row  # dòng tổng

    # Tạo workbook với nhiều sheet
    wb = openpyxl.Workbook()
    wb.remove(wb.active)

    ws_summary = wb.create_sheet("Tổng Hợp")
    sum_headers = ["STT", "Tên Tủ", "Số CB", f"Tổng Giá mua thực (CK {int(discount)}%)"]
    sum_widths  = [6, 30, 10, 30]
    for col, (h, w) in enumerate(zip(sum_headers, sum_widths), 1):
        c = ws_summary.cell(row=1, column=col, value=h)
        c.font = bold; c.fill = yellow; c.border = bdr; c.alignment = center
        ws_summary.column_dimensions[get_column_letter(col)].width = w

    total_formula_refs = []
    for i, panel_data in enumerate(panels, 1):
        pname      = panel_data.get("name", f"Tu_{i}")
        bom_input  = panel_data.get("bom_input",  [])
        bom_output = panel_data.get("bom_output", [])
        total_items = len(bom_input) + len(bom_output)

        # Tạo sheet cho tủ này
        ws = wb.create_sheet(pname[:31])
        total_row_in_sheet = write_panel_sheet(ws, pname, bom_input, bom_output)

        # Dòng tổng hợp — tham chiếu đúng dòng tổng
        sheet_ref = f"'{pname[:31]}'!I{total_row_in_sheet}"
        ws_summary.cell(row=i+1, column=1, value=i).border = bdr
        ws_summary.cell(row=i+1, column=2, value=pname).border = bdr
        ws_summary.cell(row=i+1, column=3, value=total_items).border = bdr
        c = ws_summary.cell(row=i+1, column=4, value=f"={sheet_ref}")
        c.border = bdr
        total_formula_refs.append(f"D{i+1}")

    # Dòng tổng cộng tất cả
    total_row = len(panels) + 2
    ws_summary.cell(row=total_row, column=2, value="TỔNG CỘNG").font = bold
    refs = "+".join(total_formula_refs)
    c = ws_summary.cell(row=total_row, column=4, value=f"={refs}")
    c.font = bold; c.fill = sum_yellow; c.border = bdr

    out_path = OUTPUT / f"{filename}.xlsx"
    wb.save(out_path)
    content = out_path.read_bytes()

    from urllib.parse import quote
    safe_fn = quote(f"{filename}.xlsx", safe='')
    return content, 200, {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": f"attachment; filename*=UTF-8''{safe_fn}"
    }


@app.route("/api/projects", methods=["GET"])
def list_projects():
    projects = []
    for p in DATA.glob("project_*.json"):
        with open(p, encoding="utf-8") as f:
            meta = json.load(f)
        projects.append({"file": p.name, "name": meta.get("name", p.stem), "updated": meta.get("updated", "")})
    return jsonify(sorted(projects, key=lambda x: x["updated"], reverse=True))


@app.route("/api/projects", methods=["POST"])
def save_project():
    body = request.get_json()
    name = body.get("name", "untitled").replace(" ", "_")
    from datetime import datetime
    body["updated"] = datetime.now().isoformat()
    path = DATA / f"project_{name}.json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(body, f, ensure_ascii=False, indent=2)
    return jsonify({"ok": True, "file": path.name})


@app.route("/api/projects/<filename>", methods=["GET"])
def load_project(filename):
    path = DATA / filename
    if not path.exists():
        return jsonify({"error": "Not found"}), 404
    with open(path, encoding="utf-8") as f:
        return jsonify(json.load(f))


@app.route("/api/projects/<filename>", methods=["DELETE"])
def delete_project(filename):
    path = DATA / filename
    if path.exists():
        path.unlink()
    return jsonify({"ok": True})


# ── HELPERS ───────────────────────────────────────────────────────────────────
def build_prompt(panel_name: str, extra_ctx: str = "") -> str:
    ctx = f"\nThông tin thêm: {extra_ctx}" if extra_ctx else ""
    return f"""Bạn là kỹ sư điện chuyên đọc sơ đồ 1 sợi (Single Line Diagram).
Tên tủ: {panel_name}{ctx}

Phân tích sơ đồ và bóc tách TOÀN BỘ thiết bị. Trả về JSON THUẦN TÚY (không markdown, không giải thích):

{{"panel":{{"name":"tên tủ","pe_kw":0,"cos_phi":0.85,"ijs_a":0,"source":"nguồn từ đâu"}},"devices":[
  {{"id":"CB_TONG","level":0,"name":"CB tổng","type":"MCCB","poles":3,"in":125,"icu":10,"idelta":null,"cable":"","tai":"Tủ phân phối","p_kw":0,"confidence":"high","note":""}},
  {{"id":"N1","level":1,"name":"Nhánh 1","type":"RCBO","poles":4,"in":32,"icu":6,"idelta":30,"cable":"CXV-4x4+E-1x4","tai":"Bơm nước","p_kw":7.5,"confidence":"high","note":""}}
]}}

═══ QUY TẮC CHUNG ═══
- level=0: CB tổng đầu vào (chỉ 1); level=1: CB nhánh trực tiếp; level=2: CB nhánh con
- type: chỉ dùng ACB / MCCB / MCB / RCCB / RCBO / ELCB / Contactor
- in: dòng định mức (A, số nguyên) — BẮT BUỘC
- icu: dòng cắt ngắn mạch (kA, mặc định 6 nếu không ghi)
- idelta: dòng rò (mA) — chỉ với RCCB/RCBO/ELCB, còn lại null
- poles: số cực thực tế (1/2/3/4)
  Số cực thường đọc từ: "/3P", "/4P", "3P", "4P" trong tên thiết bị
  Nếu không thấy rõ số cực → ghi confidence="low", poles=null, KHÔNG đoán mò
  Hầu hết MCCB công nghiệp VN là 3P — chỉ ghi 4P khi thấy rõ "4P" hoặc "/4"
  MCB nhánh phổ biến nhất là 3P — nếu không rõ, ghi 3P + confidence="medium"
  Khi ảnh mờ/nhỏ: ưu tiên confidence="medium" hoặc "low", không ghi confidence="high" khi không chắc
- cable: quy cách cáp nếu ghi trên sơ đồ
- tai: tên tải/thiết bị tiêu thụ
- p_kw: công suất kW, 0 nếu không có
- confidence: "high"=đọc rõ ràng, "medium"=suy luận được, "low"=mờ/không chắc
- note: giải thích ngắn nếu confidence != "high" (VD: "ảnh mờ tại vùng này", "không thấy rõ số")
- Đọc từ trên xuống, trái sang phải

═══ NGUYÊN TẮC TỐI THƯỢNG: ĐƠN VỊ QUYẾT ĐỊNH LOẠI THÔNG SỐ ═══
- Số + "A"  (ampere) = In (dòng định mức) — VD: 50A, 400A, 125A
- Số + "mA" (milliampere) = I∆n (dòng rò) — KHÔNG BAO GIỜ là In
- Số + "kA" (kiloampere) = Icu (dòng cắt) — KHÔNG BAO GIỜ là In
- kW / cosφ / kVAr = thông số tải — BỎ QUA, không phải CB
- CT / tỉ số dạng "400/5A" hoặc "3×15(6)A" = biến dòng — BỎ QUA
- Wh, ZAP, PE, N, busbar = không phải CB — BỎ QUA
- Ký hiệu đồng hồ điện (Wh, kWh) ≠ Contactor — đừng nhầm, BỎ QUA
- Contactor chỉ có khi ghi rõ "Contactor", "MC-xxA", hoặc ký hiệu cuộn dây AC
- CT RATIO — NHẬN BIẾT VÀ BỎ QUA HOÀN TOÀN:
  Pattern CT ratio: "[số]/[số]A" hoặc "[số]/5A" đặt GẦN ký hiệu đồng hồ Wh
  VD: "150/5A", "400/5A", "200/5A" — TẤT CẢ là CT, BỎ QUA
  Pattern CT dạng nhân: "3x15(6)A", "3×1.5(6)A", "3×20(80)A", "3×30(150)A" — BỎ QUA
  Số trong ngoặc "(6)", "(80)", "(150)" = dòng sơ cấp CT — KHÔNG phải In CB
  Số "15" trong "3x15(6)A" = thứ cấp CT — KHÔNG phải In CB
  ⚠ LỖI CỤ THỂ: "3x15(6)A" + "MCCB 400A" → ĐỪNG đọc In=15, đọc In=400
  Mỗi nhánh chỉ có 1 MCCB — nếu thấy cụm [Wh + số/5A], đó là đồng hồ đo, không phải CB
- Chỉ đọc CB khi ký hiệu cầu dao xuất hiện rõ (hình X hoặc ký hiệu ngắt mạch)
- Ký hiệu đồng hồ Wh + CT ratio = cụm đo lường, không có CB nào trong đó

═══ CÁCH ĐỌC FORMAT TÊN THIẾT BỊ ═══
FORMAT CHUẨN: [LOẠI]-[Frame][IcuCode][In]A/[poles]P

QUY TẮC SỐ SAU DẤU GẠCH NGANG "/" :
  - Số cuối cùng sau "/" thường là số CỰC (poles), KHÔNG phải In
  - VD: RCBO-63D50/4  → In=50, poles=4   ← "/4" là 4 cực
  - VD: MCCB-400/3P   → In=400, poles=3  ← "/3P" là 3 cực, "400" là In
  - VD: ACB-2000/3P   → In=2000, poles=3
  - VD: MCB-C16/1     → In=16, poles=1

QUY TẮC ĐỌC RCBO/ELCB (loại có dòng rò):
  - "RCBO-63D50/4" + "30mA" ghi riêng bên dưới → in=50, poles=4, idelta=30
  - "RCBO-63D32A"                               → in=32, icu=6kA (D=6kA mặc định)
  - "RCBO-63D16A"                               → in=16
  - Chữ D trong tên = mã Icu (D=6kA, H=10kA, L=15kA)
  - Số ngay trước "A" cuối cùng = In — LUÔN LUÔN

  ⚠ LỖI HAY GẶP — CẤM LẶP LẠI (KIỂM TRA TỪNG THIẾT BỊ):
  "RCBO-63D50/4" + "30mA" → SAI: in=30  |  ĐÚNG: in=50, idelta=30
  "RCBO-63D16/4" + "30mA" → SAI: in=30  |  ĐÚNG: in=16, idelta=30
  "RCBO-63D32/4" + "30mA" → SAI: in=30  |  ĐÚNG: in=32, idelta=30
  QUY TẮC TUYỆT ĐỐI: Đơn vị "mA" = dòng rò I∆n, KHÔNG BAO GIỜ là In (A)
  Số trước "mA" KHÔNG được dùng làm in — dù nó có vẻ hợp lý
  In luôn là số trước chữ D trong tên: 63D[50] → In=50, 63D[16] → In=16

QUY TẮC ĐỌC MCCB/ACB LỚN — FRAME SIZE ≠ In:
  FORMAT: [LOẠI]-[Frame]/[poles]P [In thực]A
  - "MCCB-100/3P 80A"    → frame=100, poles=3, In=80   ← "80A" sau khoảng trắng = In thực
  - "MCCB-160/3P" + "125A" ghi dòng riêng bên dưới → In=125, KHÔNG phải 160
  - "MCCB-100/3P" + "80A" ghi dòng riêng bên dưới → In=80, KHÔNG phải 100
  - "MCCB-160/3P" + "125A" ghi dòng riêng bên dưới → In=125, KHÔNG phải 160
  - "MCCB-630/3P" + "500A" ghi dòng riêng bên dưới → In=500, KHÔNG phải 630
  Quy tắc: Tên CB = [LOẠI]-[Frame]/[poles] → Frame KHÔNG phải In
  In thực luôn là số có đơn vị "A" gần ký hiệu cầu dao nhất (trên/dưới/bên cạnh)
  Nếu thấy 2 số A khác nhau gần 1 CB: số nhỏ hơn hoặc số GẦN hơn với ký hiệu CB = In
  - "MCCB-250/3P 160A"   → frame=250, poles=3, In=160  ← "160A" sau khoảng trắng = In thực
  - "MCCB-400/3P 400A"   → frame=400, poles=3, In=400
  - "MCCB-630/3P 500A"   → frame=630, poles=3, In=500
  - "MCCB-160/8P 125A"   → frame=160, poles=3 (8P là số thứ tự frame), In=125
  - "ACB-1600/3P"        → In=1600, poles=3 (không có frame riêng)

  FRAME SIZE thường gặp (KHÔNG phải In): 100, 160, 250, 400, 630, 800, 1000, 1600, 2000, 3200
  ⚠ "MCCB-160/3P" → frame=160, KHÔNG phải In=160. Phải tìm số A phía sau = In thực
  ⚠ "MCCB-160/3P 125A" → In=125 (số sau khoảng trắng). "160" chỉ là frame size
  Nếu thấy 2 số khác nhau — số gắn với "A" rõ nhất sau khoảng trắng = In thực
  Khi chỉ có 1 số: "MCCB-400/3P" → In=400 (không có số thứ 2, lấy số đó)

  Icu thường ghi riêng: "50kA", "36kA", "85kA" — đơn vị kA, KHÔNG nhầm với In

═══ CONFIDENCE — BẮT BUỘC ĐÁNH GIÁ TỪNG THIẾT BỊ ═══
- "high"  : nhìn rõ ký hiệu, đọc chắc chắn In/poles/type
- "medium": suy luận từ ngữ cảnh, ảnh hơi mờ nhưng còn đọc được
- "low"   : ảnh mờ, bị che, không rõ thông số — PHẢI ghi note giải thích

Khi confidence="low" hoặc "medium": ghi rõ vào "note" phần nào không chắc.
VD: {{"confidence":"low","note":"vùng CB tổng bị mờ, không đọc được In — chỉ thấy MCCB 3P"}}

KHÔNG tự điền số khi không đọc được — để null và ghi note."""


# Dải In hợp lệ theo loại CB (A)
_VALID_IN = {
    "MCB":       [1,2,3,4,6,8,10,13,16,20,25,32,40,50,63,80,100,125],
    "MCCB":      [15,20,25,30,32,40,50,63,75,80,100,125,150,160,175,200,225,250,
                  300,350,400,500,630,700,800,1000,1200,1250,1600,2000,2500,3200],
    "ACB":       [630,700,800,1000,1250,1600,2000,2500,3200,4000,5000,6300],
    "RCBO":      [6,10,13,16,20,25,32,40,50,63,80,100],
    "RCCB":      [16,25,32,40,63,80,100,125,160,200,250],
    "ELCB":      [15,16,20,25,30,32,40,50,63,75,80,100,125,150,175,200,225,250,300,350,400],
    "Contactor": [6,9,12,18,22,32,40,50,65,75,85,100,130,150,185,225,265,330,400,500,630,800],
}
# CT ratio secondaries thường gặp — nếu AI trả về In = 1 trong list này thì nghi ngờ
_CT_SECONDARIES = {1, 2, 3, 5, 6, 10, 15}

def _validate_device(dev: dict) -> dict:
    """Validate và fix giá trị In không hợp lý từ AI."""
    in_val  = dev.get("in")
    dev_type = dev.get("type", "")
    if in_val is None:
        return dev

    valid_list = _VALID_IN.get(dev_type, [])
    if not valid_list:
        return dev

    # In quá nhỏ so với loại CB — likely AI đọc CT ratio
    min_in = min(valid_list)
    max_in = max(valid_list)
    if in_val < min_in or in_val > max_in:
        dev = dict(dev)
        dev["confidence"] = "low"
        dev["note"] = f"In={in_val}A ngoài dải hợp lệ cho {dev_type} ({min_in}-{max_in}A) — có thể nhầm CT ratio"
        dev["in"] = None  # Để matcher biết không tin
    elif in_val in _CT_SECONDARIES and dev_type in ("MCCB", "ACB"):
        dev = dict(dev)
        dev["confidence"] = "low"
        dev["note"] = f"In={in_val}A nghi là CT ratio secondary (thường gặp: 1A, 5A, 6A, 15A) — kiểm tra lại"
        dev["in"] = None

    # Validate poles
    poles = dev.get("poles")
    if poles is not None:
        valid_poles = {
            "MCB": [1,2,3,4], "MCCB": [2,3,4], "ACB": [3,4],
            "RCBO": [1,2,3,4], "RCCB": [2,4], "ELCB": [2,3,4],
            "Contactor": [3],
        }
        vp = valid_poles.get(dev_type, [1,2,3,4])
        if poles not in vp:
            dev = dict(dev)
            dev["confidence"] = "low"
            dev["note"] = dev.get("note","") + f" | poles={poles} không hợp lệ cho {dev_type}"
            dev["poles"] = None
    return dev

def parse_json_response(text: str) -> dict:
    import re
    # strip markdown fences
    clean = re.sub(r"```json|```", "", text).strip()
    try:
        data = json.loads(clean)
    except:
        m = re.search(r"\{[\s\S]*\}", text)
        if m:
            data = json.loads(m.group())
        else:
            raise ValueError("Không tìm thấy JSON trong phản hồi AI")
    devices = data.get("devices", data) if isinstance(data, dict) else data
    panel   = data.get("panel", {}) if isinstance(data, dict) else {}
    # Validate từng thiết bị
    if isinstance(devices, list):
        devices = [_validate_device(d) for d in devices]
    return {"devices": devices, "panel": panel}


def generate_dxf(layout: dict) -> str:
    placed = layout.get("placed", [])
    W  = layout.get("W", 800)
    H  = layout.get("H", 2000)
    WV = layout.get("WV", 60)
    CB = layout.get("CB", 200)
    name = layout.get("name", "Panel")

    lines = []
    def fy(y): return H - y  # DXF Y flip

    def add_line(x1, y1, x2, y2, layer="0"):
        lines.append(f"0\nLINE\n8\n{layer}\n10\n{x1:.1f}\n20\n{fy(y1):.1f}\n30\n0.0\n"
                     f"11\n{x2:.1f}\n21\n{fy(y2):.1f}\n31\n0.0")

    def add_rect(x1, y1, x2, y2, layer="0"):
        add_line(x1,y1,x2,y1,layer); add_line(x2,y1,x2,y2,layer)
        add_line(x2,y2,x1,y2,layer); add_line(x1,y2,x1,y1,layer)

    def add_text(x, y, text, h=5, layer="TEXT"):
        lines.append(f"0\nTEXT\n8\n{layer}\n10\n{x:.1f}\n20\n{fy(y):.1f}\n30\n0.0\n40\n{h}\n1\n{text}")

    # Cabinet outline
    add_rect(0, 0, W, H, "CABINET")
    add_text(W/2, H-15, name, 10, "TITLE")
    # Cable space
    add_rect(0, 0, W, CB, "CABLE_SPACE")
    add_text(W/2, CB/2, "CABLE SPACE", 8, "TEXT")
    # Side ducts
    add_rect(0, CB, WV, H-80, "DUCT")
    add_rect(W-WV, CB, W, H-80, "DUCT")

    for ri, row in enumerate(placed):
        ry = row.get("railY", 0)
        # DIN rail bar
        add_line(WV, ry+20, W-WV, ry+20, "RAIL")
        add_text(WV+2, ry+10, f"R{ri+1}", 4, "RAIL_LABEL")
        for item in row.get("items", []):
            x = item.get("x", 0)
            w = item.get("w", 27)
            dev = item.get("dev", {})
            add_rect(x, ry, x+w, ry+20, "DEVICE")
            add_text(x+w/2, ry+10, f"{dev.get('in','')}A", 4, "DEVICE_LABEL")
            add_text(x+1, ry+17, dev.get('type',''), 3, "DEVICE_TYPE")

    header = "0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1009\n0\nENDSEC\n"
    body   = "0\nSECTION\n2\nENTITIES\n" + "\n".join(lines) + "\n0\nENDSEC\n0\nEOF\n"
    return header + body


# ── RUN ───────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    init_db()
    print("=" * 60)
    print("  Panel Designer — http://127.0.0.1:8080")
    print("=" * 60)
    print(f"  Data:    {DATA}")
    print(f"  Uploads: {UPLOAD}")
    print(f"  Outputs: {OUTPUT}")
    key = os.environ.get("ANTHROPIC_API_KEY", "")
    if key:
        print(f"  API Key: {key[:8]}...")
    else:
        print("  ⚠  ANTHROPIC_API_KEY chưa đặt!")
        print("     Đặt bằng: export ANTHROPIC_API_KEY=sk-ant-...")
    print("=" * 60)
    port = int(os.getenv("PORT", 8080))
    app.run(host="0.0.0.0", port=port, debug=False, threaded=True)
