"""FloodGuard camera AI calibration wizard (Windows Tkinter).

Single responsive GUI: 0 cm point -> 5 cm ROI + point -> 10 cm point.
No OpenCV windows or terminal input calls. Snapshot fetching is on a
background thread, so HTTP delays never block the GUI event loop.
"""
import base64
import json
import queue
import threading
import tkinter as tk
from pathlib import Path
from tkinter import messagebox

import cv2

from relay import discover_camera_url
from snapshot_reader import fetch_snapshot

CONFIG = Path(__file__).with_name("camera-ai.json")
LEVELS = (0, 5, 10)


class CalibrationApp:
    def __init__(self, root):
        self.root = root
        self.root.title("FloodGuard AI Calibration - 0 / 5 / 10 cm")
        self.root.geometry("820x720")
        self.root.minsize(640, 570)
        self.cfg = json.loads(CONFIG.read_text(encoding="utf-8"))
        self.step = 0
        self.mode = "point"
        self.frame = None
        self.photo = None
        self.selected = None
        self.roi_start = None
        self.roi = None
        self.points = {}
        self.result_queue = queue.Queue()
        self.loading = False

        header = tk.Frame(root, padx=12, pady=10)
        header.pack(fill="x")
        self.help_text = tk.StringVar()
        tk.Label(header, textvariable=self.help_text, justify="left",
                 anchor="w", wraplength=760, font=("Segoe UI", 11)).pack(fill="x")

        self.canvas = tk.Canvas(root, bg="#17202b", highlightthickness=0,
                                cursor="crosshair")
        self.canvas.pack(fill="both", expand=True, padx=12, pady=6)
        self.canvas.bind("<ButtonPress-1>", self.mouse_down)
        self.canvas.bind("<B1-Motion>", self.mouse_move)
        self.canvas.bind("<ButtonRelease-1>", self.mouse_up)

        controls = tk.Frame(root, padx=12, pady=12)
        controls.pack(fill="x")
        self.fetch_button = tk.Button(controls, text="Chụp ảnh mức 0 cm",
                                      command=self.capture, height=2)
        self.fetch_button.pack(side="left", padx=(0, 8))
        self.next_button = tk.Button(controls, text="Xác nhận điểm",
                                     command=self.confirm, height=2,
                                     state="disabled")
        self.next_button.pack(side="left", padx=(0, 8))
        tk.Button(controls, text="Chọn lại", command=self.reset_selection,
                  height=2).pack(side="left")
        self.status = tk.StringVar(value="Đang chờ chụp ảnh...")
        tk.Label(root, textvariable=self.status, anchor="w", padx=12,
                 pady=5, fg="#284b73").pack(fill="x")
        self.refresh_instructions()
        self.root.after(100, self.poll_result)

    def refresh_instructions(self):
        cm = LEVELS[self.step]
        if self.frame is None:
            msg = (f"Bước {self.step + 1}/3 — Đưa nước đến {cm} cm, để yên, "
                   f"rồi nhấn 'Chụp ảnh mức {cm} cm'. Đóng relay.py "
                   "và tab /stream trước khi hiệu chuẩn.")
        elif self.step == 1 and self.mode == "roi":
            msg = ("Bước 2/3 — Kéo hình chữ nhật hẹp, cao, cạnh thước, "
                   "nơi ranh giới nước xanh sẽ di chuyển qua từ 0–10 cm; "
                   "rồi bấm 'Xác nhận ROI'.")
        else:
            msg = (f"Bước {self.step + 1}/3 — Click vào mốc {cm} cm "
                   "trên thước (mức 0 ở đáy; 5/10 ở đường nước tại thước), "
                   "rồi bấm 'Xác nhận điểm'.")
        self.help_text.set(msg)
        self.fetch_button.config(text=f"Chụp ảnh mức {cm} cm",
                                 state="disabled" if self.loading else "normal")
        self.next_button.config(text="Xác nhận ROI" if self.mode == "roi"
                                else "Xác nhận điểm")

    def capture(self):
        if self.loading:
            return
        self.loading = True
        self.selected = None
        self.roi_start = None
        self.roi = None
        self.frame = None
        self.canvas.delete("all")
        self.next_button.config(state="disabled")
        self.status.set("Đang nhận ảnh từ ESP32... cửa sổ vẫn có thể thao tác.")
        self.refresh_instructions()

        def job():
            try:
                url = discover_camera_url()
                # Conservative timeout and no extra preflight snapshot.
                image = fetch_snapshot(url, timeout=15)
                self.result_queue.put(("ok", image, url))
            except Exception as exc:
                self.result_queue.put(("error", str(exc), None))
        threading.Thread(target=job, daemon=True).start()

    def poll_result(self):
        try:
            kind, value, url = self.result_queue.get_nowait()
        except queue.Empty:
            pass
        else:
            self.loading = False
            if kind == "error":
                self.status.set("Không lấy được ảnh: " + value)
            else:
                self.frame = value
                self.mode = "roi" if self.step == 1 else "point"
                self.status.set(f"Đã nhận ảnh {value.shape[1]}x{value.shape[0]} từ {url}")
                self.draw()
            self.refresh_instructions()
        self.root.after(100, self.poll_result)

    def scale_offset(self):
        h, w = self.frame.shape[:2]
        cw = max(1, self.canvas.winfo_width())
        ch = max(1, self.canvas.winfo_height())
        factor = min(cw / w, ch / h, 1.5)
        nw, nh = max(1, round(w * factor)), max(1, round(h * factor))
        return (nw, nh, (cw - nw)//2, (ch - nh)//2)

    def image_coord(self, event):
        if self.frame is None:
            return None
        nw, nh, ox, oy = self.scale_offset()
        x = (event.x - ox) / nw * self.frame.shape[1]
        y = (event.y - oy) / nh * self.frame.shape[0]
        if not (0 <= x < self.frame.shape[1] and 0 <= y < self.frame.shape[0]):
            return None
        return (round(x), round(y))

    def draw(self):
        if self.frame is None:
            return
        h, w = self.frame.shape[:2]
        nw, nh, ox, oy = self.scale_offset()
        rgb = cv2.cvtColor(cv2.resize(self.frame, (nw, nh)), cv2.COLOR_BGR2RGB)
        ok, encoded = cv2.imencode(".png", cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR))
        if not ok:
            self.status.set("Lỗi chuyển ảnh xem trước")
            return
        self.photo = tk.PhotoImage(data=base64.b64encode(encoded.tobytes()).decode("ascii"))
        self.canvas.delete("all")
        self.canvas.create_image(ox, oy, anchor="nw", image=self.photo)
        if self.mode == "point" and self.selected:
            x, y = self.selected
            px, py = ox + x/w*nw, oy + y/h*nh
            self.canvas.create_oval(px-6, py-6, px+6, py+6, outline="yellow", width=3)
        if self.roi:
            x1, y1, x2, y2 = self.roi
            self.canvas.create_rectangle(ox+x1/w*nw, oy+y1/h*nh,
                                         ox+x2/w*nw, oy+y2/h*nh,
                                         outline="yellow", width=3)

    def mouse_down(self, event):
        pos = self.image_coord(event)
        if pos is None:
            return
        if self.mode == "roi":
            self.roi_start = pos
            self.roi = None
        else:
            self.selected = pos
            self.next_button.config(state="normal")
        self.draw()

    def mouse_move(self, event):
        if self.mode != "roi" or self.roi_start is None:
            return
        pos = self.image_coord(event)
        if pos:
            x1, y1 = self.roi_start
            self.roi = (min(x1, pos[0]), min(y1, pos[1]),
                        max(x1, pos[0]), max(y1, pos[1]))
            self.draw()

    def mouse_up(self, event):
        if self.mode != "roi" or self.roi_start is None:
            return
        self.mouse_move(event)
        self.roi_start = None
        if self.roi:
            x1, y1, x2, y2 = self.roi
            if x2-x1 >= 12 and y2-y1 >= 20:
                self.next_button.config(state="normal")
            else:
                self.roi = None
                self.status.set("ROI quá nhỏ, hãy kéo lại vùng rộng >=12 px, cao >=20 px")
                self.draw()

    def reset_selection(self):
        self.roi = None
        self.selected = None
        self.roi_start = None
        self.next_button.config(state="disabled")
        self.draw()

    def confirm(self):
        if self.frame is None:
            return
        h, w = self.frame.shape[:2]
        if self.mode == "roi":
            if not self.roi:
                return
            x1, y1, x2, y2 = self.roi
            self.cfg["roi"] = {"x1":round(x1/w,5), "y1":round(y1/h,5),
                               "x2":round(x2/w,5), "y2":round(y2/h,5)}
            self.mode = "point"
            self.roi = None
            self.next_button.config(state="disabled")
            self.refresh_instructions()
            self.draw()
            return
        if self.selected is None:
            return
        cm = LEVELS[self.step]
        self.points[cm] = round(self.selected[1]/h,5)
        if self.step < 2:
            self.step += 1
            self.frame = None
            self.selected = None
            self.next_button.config(state="disabled")
            self.canvas.delete("all")
            self.status.set(f"Đã lưu mốc {cm} cm. Đưa nước tới {LEVELS[self.step]} cm trước khi chụp.")
            self.refresh_instructions()
            return

        ys = [self.points[c] for c in LEVELS]
        if not (ys[2] < ys[1] < ys[0]):
            messagebox.showerror("Hiệu chuẩn không hợp lệ",
                                 "Các điểm phải theo thứ tự y10 < y5 < y0. "
                                 "Kiểm tra góc camera và điểm đã chọn.")
            self.step = 0
            self.points.clear()
            self.frame = None
            self.selected = None
            self.next_button.config(state="disabled")
            self.canvas.delete("all")
            self.refresh_instructions()
            return
        self.cfg["anchors"] = [{"cm":cm, "y":self.points[cm]} for cm in LEVELS]
        self.cfg["full_cm"] = 10
        self.cfg["calibrated"] = True
        CONFIG.write_text(json.dumps(self.cfg, indent=2, ensure_ascii=False)+"\n",
                          encoding="utf-8")
        self.status.set("Đã lưu camera-ai.json — cần kiểm tra sai số tại 2,4,6,8 cm.")
        messagebox.showinfo("Hoàn thành",
                            "Đã lưu mốc 0/5/10 cm vào camera-ai.json. "
                            "Đây là hiệu chuẩn thử nghiệm; hãy kiểm chứng sai số.")
        self.next_button.config(state="disabled")
        self.fetch_button.config(state="disabled")


if __name__ == "__main__":
    root = tk.Tk()
    app = CalibrationApp(root)
    root.bind("<Configure>", lambda event: app.draw() if event.widget is app.canvas and app.frame is not None else None)
    root.mainloop()
