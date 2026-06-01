# Panel Designer v1.1
## Thiết kế tủ điện tự động — Chạy Local

### Cài đặt và chạy

```bash
# 1. Cài dependencies
pip install flask flask-cors anthropic openpyxl

# 2. Đặt API key
export ANTHROPIC_API_KEY=sk-ant-api03-...

# 3. Chạy server
python app.py

# 4. Mở trình duyệt
# http://127.0.0.1:8080
```

### Cấu trúc thư mục

```
paneldesigner/
├── app.py                 # Flask backend (API + serve)
├── requirements.txt       # Python dependencies
├── templates/
│   └── index.html         # Giao diện chính (5 tab)
├── static/
│   ├── css/
│   │   └── main.css       # Toàn bộ styles
│   └── js/
│       ├── core.js        # State, utils, API helpers
│       ├── sld.js         # Tab SLD Reader
│       ├── layout.js      # Tab Layout Engine
│       └── tabs.js        # Library, Export, Project tabs
├── data/
│   ├── db_ls.json         # Database LS Electric 2026
│   ├── db_schneider.json  # Database Schneider
│   └── project_*.json     # Dự án đã lưu (auto-generated)
├── uploads/               # File SLD upload (auto)
└── outputs/               # File DXF export (auto)
```

### API Endpoints

| Method | URL | Mô tả |
|--------|-----|-------|
| GET  | `/` | Giao diện chính |
| POST | `/api/analyze` | Claude Vision đọc SLD → JSON |
| GET  | `/api/library?brand=ls` | Lấy danh sách thiết bị |
| POST | `/api/library` | Thêm thiết bị mới |
| DELETE | `/api/library/<brand>/<ma_sp>` | Xóa thiết bị |
| POST | `/api/export/dxf` | Sinh file DXF |
| GET  | `/api/projects` | Danh sách dự án |
| POST | `/api/projects` | Lưu dự án |
| GET  | `/api/projects/<file>` | Mở dự án |
| DELETE | `/api/projects/<file>` | Xóa dự án |

### Workflow

```
1. Upload SLD (JPG/PNG/PDF) → Nhấn "Phân tích AI"
   → Claude Vision đọc → Bảng thiết bị tự động điền

2. Kiểm tra bảng → Chỉnh sửa In/Icu/cực nếu cần

3. Tab Layout → ▶ Chạy Auto-Layout
   → Greedy Bin-Packing → SVG mặt trước/trong + SLD tự động

4. Tab Xuất file → Download BOM CSV + SVG + DXF

5. Tab Dự án → Lưu để dùng lại phiên sau
```

### Nâng cấp phiên sau

- [ ] Bổ sung DB ABB, Mitsubishi
- [ ] Quy tắc khoảng cách an toàn (IEC 61439)
- [ ] Multi-panel (tủ nhiều ngăn)
- [ ] Kiểm tra bảo vệ Isc
- [ ] Import DXF trực tiếp (ezdxf)
- [ ] Export DXF nâng cao (layer, block, dim)
