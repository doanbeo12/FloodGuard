// ============================================================
// FLOOD MONITORING DASHBOARD v1.5.4 - Hs=39 cm - Sensor-based Early Warning
// Payload mới từ ESP32 Central:
// {
//   "node1Distance": 33.0,
//   "node2Distance": 35.0,
//   "node1WaterLevel": 7.0,
//   "node2WaterLevel": 5.0,
//   "maxWaterLevel": 7.0,
//   "node1Online": true,
//   "node2Online": true,
//   "node1MeasurementValid": true,
//   "node2MeasurementValid": true,
//   "monitoringDegraded": false,
//   "raining": true,
//   "alertLevel": 2,
//   "scenario": "FLOOD_LEVEL_1_RISK_2"
// }
// ============================================================

const MQTT_CONFIG = {
    url: "wss://broker.hivemq.com:8884/mqtt",
    topic: "flood-monitoring/a8f3c2/data",
    reconnectPeriod: 2000,
    centralTimeoutMs: 8000
};

const SENSOR_HEIGHT_CM = 39;
const WATER_VISUAL_MAX_CM = 20;
const CHART_MAX_POINTS = 60;

const ALERT_LEVEL_META = {
    0: { label: "Bình thường", badge: "bg-success" },
    1: { label: "Mức 1", badge: "bg-success" },
    2: { label: "Mức 1 - Nguy cơ mức 2", badge: "bg-warning text-dark" },
    3: { label: "Mức 2", badge: "bg-warning text-dark" },
    4: { label: "Mức 3", badge: "bg-danger" }
};

const SCENARIO_META = {
    WAITING: {
        title: "Đang chờ dữ liệu",
        message: "Dashboard chưa nhận đủ dữ liệu để phân tích.",
        severity: "WAIT",
        badge: "bg-secondary",
        panel: "alert-offline",
        icon: "…"
    },
    NORMAL_DRY: {
        title: "Trạng thái bình thường",
        message: "Không mưa và chưa phát hiện mực nước bất thường.",
        severity: "NORMAL",
        badge: "bg-success",
        panel: "alert-normal",
        icon: "✓"
    },
    RAIN_NO_FLOOD: {
        title: "Có mưa - chưa ngập",
        message: "Cảm biến mưa đang kích hoạt nhưng mực nước vẫn dưới ngưỡng cảnh báo.",
        severity: "INFO",
        badge: "bg-primary",
        panel: "alert-info",
        icon: "☔"
    },
    EARLY_WARNING: {
        title: "Cảnh báo sớm nguy cơ đạt ngưỡng",
        message: "Mực nước chưa đạt ngưỡng tiếp theo nhưng xu hướng dâng đã được xác nhận và ETA nằm trong cửa sổ cảnh báo sớm.",
        severity: "EARLY",
        badge: "bg-warning text-dark",
        panel: "alert-warning-1",
        icon: "⏱"
    },
    TRANSIENT_ANOMALY: {
        title: "Biến động tạm thời",
        message: "Giá trị chỉ thay đổi trong thời gian ngắn rồi trở lại bình thường; có thể do tay, xe, vật cản hoặc nước xuất hiện thoáng qua.",
        severity: "CHECK",
        badge: "bg-info text-dark",
        panel: "alert-info",
        icon: "↕"
    },
    OBSTRUCTION_SUSPECTED: {
        title: "Nghi vật cản / xe dừng",
        message: "Một node có giá trị khác thường so với node còn lại. Hãy kiểm tra xem cảm biến có bị tay, xe hoặc vật khác che hay không.",
        severity: "WARNING",
        badge: "bg-warning text-dark",
        panel: "alert-warning-1",
        icon: "⚠"
    },
    DRY_WATER_MONITORING: {
        title: "Có nước khi không mưa - đang theo dõi",
        message: "Hệ thống phát hiện nước trong điều kiện không mưa nhưng chưa đủ thời gian để xác định mẫu bất thường kéo dài.",
        severity: "CHECK",
        badge: "bg-info text-dark",
        panel: "alert-info",
        icon: "◷"
    },
    PIPE_LEAK_SUSPECTED: {
        title: "Nghi rò rỉ / nguồn nước bất thường",
        message: "Mực nước tồn tại kéo dài trong điều kiện không mưa. Đây là nhận định nghi ngờ, không phải kết luận nguyên nhân tuyệt đối.",
        severity: "WARNING",
        badge: "bg-warning text-dark",
        panel: "alert-warning-2",
        icon: "⚠"
    },
    TIDE_BACKFLOW_SUSPECTED: {
        title: "Nghi triều cường / nước cống trào",
        message: "Không mưa, Node 1 gần cống phát hiện nước trước Node 2 và hiện tượng duy trì đủ lâu; phù hợp mẫu nước lan từ phía cống.",
        severity: "WARNING",
        badge: "bg-warning text-dark",
        panel: "alert-warning-2",
        icon: "🌊"
    },
    OTHER_WATER_SOURCE_SUSPECTED: {
        title: "Nghi nguồn nước từ vị trí khác",
        message: "Node 2 phát hiện nước trước Node 1; hướng lan không phù hợp mẫu nước xuất phát từ cống gần Node 1.",
        severity: "WARNING",
        badge: "bg-warning text-dark",
        panel: "alert-warning-1",
        icon: "↔"
    },
    FLOOD_LEVEL_1: {
        title: "Cảnh báo mức 1",
        message: "Mực nước đã đạt khoảng 3 cm, tương ứng rãnh thoát nước bắt đầu đầy.",
        severity: "LEVEL 1",
        badge: "bg-success",
        panel: "alert-warning-1",
        icon: "!"
    },
    FLOOD_LEVEL_1_RISK_2: {
        title: "Mức 1 - nguy cơ mức 2",
        message: "Mực nước đạt từ 7 cm; nước bắt đầu tích tụ trên mặt đường và cần theo dõi khả năng tăng tiếp.",
        severity: "RISK 2",
        badge: "bg-warning text-dark",
        panel: "alert-warning-2",
        icon: "⚠"
    },
    FLOOD_LEVEL_2: {
        title: "Cảnh báo mức 2",
        message: "Mực nước đạt từ 10 cm và có khả năng ảnh hưởng đến giao thông trên tuyến đường.",
        severity: "LEVEL 2",
        badge: "bg-warning text-dark",
        panel: "alert-warning-2",
        icon: "⚠"
    },
    FLOOD_LEVEL_3: {
        title: "Cảnh báo mức 3 - ngập nghiêm trọng",
        message: "Mực nước đạt từ 15 cm. Hệ thống xác định trạng thái ngập nghiêm trọng, có nguy cơ gián đoạn giao thông.",
        severity: "LEVEL 3",
        badge: "bg-danger",
        panel: "alert-danger",
        icon: "!"
    },
    DRAINAGE_RECOVERY: {
        title: "Mực nước đang rút",
        message: "Mực nước đã giảm sau giai đoạn cảnh báo; hệ thống đang theo dõi quá trình phục hồi thoát nước.",
        severity: "RECOVERY",
        badge: "bg-success",
        panel: "alert-normal",
        icon: "↓"
    },
    DRAINAGE_BLOCKED_SUSPECTED: {
        title: "Nghi cống nghẹt / thoát nước kém",
        message: "Mưa đã kết thúc nhưng mực nước vẫn duy trì quá lâu, phù hợp dấu hiệu thoát nước chậm hoặc cống bị cản trở.",
        severity: "WARNING",
        badge: "bg-warning text-dark",
        panel: "alert-warning-2",
        icon: "⚠"
    },
    NODE_DEGRADED: {
        title: "Hệ thống giám sát suy giảm",
        message: "Một Node đang offline hoặc phép đo không hợp lệ. Hệ thống tiếp tục sử dụng dữ liệu hợp lệ còn lại.",
        severity: "DEGRADED",
        badge: "bg-warning text-dark",
        panel: "alert-warning-1",
        icon: "⚠"
    },
    SENSOR_FAULT: {
        title: "Lỗi phép đo cảm biến",
        message: "Dữ liệu cảm biến nằm ngoài vùng hợp lệ hoặc không thể sử dụng để tính mực nước.",
        severity: "FAULT",
        badge: "bg-danger",
        panel: "alert-danger",
        icon: "×"
    },
    NODES_OFFLINE: {
        title: "Hai Node mất kết nối",
        message: "Central không nhận dữ liệu từ cả Node 1 và Node 2. Không được xem trạng thái này là không ngập.",
        severity: "OFFLINE",
        badge: "bg-danger",
        panel: "alert-danger",
        icon: "×"
    }
};



// ===================== T01–T26 HYPOTHESIS CATALOG =====================
// Các mục dưới đây bám theo bộ thí nghiệm của đề cương. "auto" chỉ mô tả
// khả năng suy luận từ telemetry hiện có; các test hiệu chuẩn cần chạy chủ động.
const TEST_GROUP_NAMES = {
    A: "Hiệu chuẩn",
    B: "Mức nước",
    C: "Hướng nước",
    D: "Chống nhiễu",
    E: "Kết nối",
    F: "Mưa & thoát nước"
};

const TEST_CASES = {
    T01: { group: "A", title: "Mô hình khô, không mưa", expected: "Hai node đo ổn định và hệ thống hiển thị trạng thái bình thường, không cảnh báo.", auto: true },
    T02: { group: "A", title: "Kiểm tra cảm biến tại 0 / 3 / 7 / 10 / 15 cm", expected: "So sánh số đo của cảm biến với thước để biết cảm biến đo lệch bao nhiêu.", auto: false },
    T03: { group: "A", title: "Đo lại khi nhiệt độ thay đổi", expected: "Kiểm tra nhiệt độ môi trường có làm số đo siêu âm thay đổi đáng kể hay không.", auto: false },
    T04: { group: "B", title: "Giữ mực nước khoảng 3 cm", expected: "Hệ thống chuyển sang cảnh báo mức 1.", auto: true },
    T05: { group: "B", title: "Giữ mực nước khoảng 7 cm", expected: "Hệ thống báo vùng nguy cơ và bật trạng thái cảnh báo màu vàng.", auto: true },
    T06: { group: "B", title: "Giữ mực nước khoảng 10 cm", expected: "Hệ thống chuyển sang cảnh báo mức 2.", auto: true },
    T07: { group: "B", title: "Giữ mực nước khoảng 15 cm", expected: "Hệ thống báo mức 3. Buzzer chỉ kêu khi cả hai node hợp lệ và chênh nhau không quá 2 cm.", auto: true },
    T08: { group: "B", title: "Cho nước dâng chậm", expected: "Các mức cảnh báo phải tăng lần lượt, không nhảy qua ngưỡng.", auto: true },
    T09: { group: "B", title: "Cho nước dâng nhanh", expected: "Hệ thống nhận biết nước đang dâng nhanh và có thể phát cảnh báo sớm trước ngưỡng tiếp theo.", auto: true },
    T10: { group: "C", title: "Node 1 thấy nước trước", expected: "Hệ thống ghi nhận nước có xu hướng xuất hiện từ phía Node 1 trước.", auto: true },
    T11: { group: "C", title: "Node 2 thấy nước trước", expected: "Hệ thống ghi nhận nước có xu hướng xuất hiện từ phía Node 2 trước.", auto: true },
    T12: { group: "C", title: "Hai node thấy nước gần cùng lúc", expected: "Không kết luận hướng nước; chỉ dùng dữ liệu để xác định mức ngập.", auto: true },
    T13: { group: "D", title: "Nước xuất hiện ngắn rồi rút", expected: "Coi là biến động ngắn, không nâng ngay lên cảnh báo ngập cao.", auto: true },
    T14: { group: "D", title: "Tay / xe / vật đi ngang cảm biến vài giây", expected: "Hệ thống coi là nhiễu tạm thời và không cho buzzer kêu do một lần che cảm biến ngắn.", auto: true },
    T15: { group: "D", title: "Vật che một cảm biến trong thời gian dài", expected: "Hệ thống báo nghi có vật cản, không tự kết luận đó là nước ngập.", auto: true },
    T16: { group: "D", title: "Mặt nước có sóng hoặc bị khuấy", expected: "Cảnh báo phải ổn định, không thay đổi liên tục theo từng gợn sóng.", auto: true },
    T17: { group: "D", title: "Mực nước dao động quanh ngưỡng", expected: "Hysteresis giúp giữ trạng thái ổn định, tránh cảnh báo bật/tắt liên tục.", auto: true },
    T18: { group: "E", title: "Mất một node cảm biến", expected: "Dashboard báo mất một node và tiếp tục theo dõi bằng node còn hoạt động.", auto: true },
    T19: { group: "E", title: "Mất cả hai node cảm biến", expected: "Hệ thống báo mất dữ liệu mực nước; không được hiểu là đang khô hoặc an toàn.", auto: true },
    T20: { group: "E", title: "Mất 4G / Internet của Central", expected: "Cảnh báo tại chỗ trên Central vẫn hoạt động, nhưng Dashboard sẽ ngừng nhận dữ liệu mới.", auto: "limited" },
    T21: { group: "E", title: "MQTT broker không hoạt động", expected: "Cảnh báo tại chỗ vẫn hoạt động, còn Dashboard không nhận được dữ liệu mới qua MQTT.", auto: "limited" },
    T22: { group: "E", title: "Kiểm tra chất lượng ESP-NOW", expected: "Theo dõi tỷ lệ gói tin nhận được từ Node 1 và Node 2 để đánh giá độ ổn định kết nối.", auto: true },
    T23: { group: "F", title: "Có mưa, nước dâng rồi rút", expected: "Hệ thống nhận biết giai đoạn có mưa và theo dõi khi mực nước bắt đầu giảm trở lại.", auto: true },
    T24: { group: "F", title: "Có mưa nhưng nước rút rất chậm", expected: "Hệ thống có thể báo nghi thoát nước kém hoặc đường thoát nước bị cản trở.", auto: true },
    T25: { group: "F", title: "Cảm biến mưa còn ướt nhưng nước đang rút", expected: "Hệ thống ưu tiên diễn biến mực nước, không kết luận ngập chỉ vì cảm biến mưa còn báo ướt.", auto: true },
    T26: { group: "F", title: "Không mưa nhưng vẫn có nước kéo dài", expected: "Hệ thống chỉ báo có nguồn nước bất thường cần kiểm tra, không khẳng định chắc chắn là rò rỉ.", auto: true }
};

const hypothesisHistory = [];

function confidenceMeta(level) {
    const map = {
        HIGH: { text: "Cao", badge: "bg-success", cls: "hypothesis-high" },
        MEDIUM: { text: "Trung bình", badge: "bg-warning text-dark", cls: "hypothesis-medium" },
        LOW: { text: "Thấp / cần quan sát thêm", badge: "bg-info text-dark", cls: "hypothesis-low" },
        NONE: { text: "Chưa đủ dữ liệu", badge: "bg-secondary", cls: "hypothesis-none" }
    };
    return map[level] || map.NONE;
}

function pushHypothesisHistory() {
    const max = state.maxWaterLevel == null ? null : Number(state.maxWaterLevel);
    hypothesisHistory.push({
        t: Date.now(),
        max,
        level: state.alertLevel,
        trend: state.trend,
        raining: state.raining
    });
    const cutoff = Date.now() - 65000;
    while (hypothesisHistory.length && hypothesisHistory[0].t < cutoff) hypothesisHistory.shift();
}

function thresholdCrossings(threshold, windowMs = 60000) {
    const cutoff = Date.now() - windowMs;
    const samples = hypothesisHistory.filter(p => p.t >= cutoff && p.max != null);
    let count = 0;
    for (let i = 1; i < samples.length; i++) {
        const a = samples[i - 1].max - threshold;
        const b = samples[i].max - threshold;
        if ((a < 0 && b >= 0) || (a >= 0 && b < 0)) count++;
    }
    return count;
}

function recentRange(windowMs = 8000) {
    const cutoff = Date.now() - windowMs;
    const values = hypothesisHistory.filter(p => p.t >= cutoff && p.max != null).map(p => p.max);
    if (values.length < 3) return null;
    return { min: Math.min(...values), max: Math.max(...values), range: Math.max(...values) - Math.min(...values) };
}

function hypothesisCandidate(code, confidence, conclusion, evidence) {
    return { code, confidence, conclusion, evidence, meta: TEST_CASES[code] };
}

function deriveHypothesis(fresh) {
    const related = [];
    const addRelated = code => { if (code && !related.includes(code)) related.push(code); };

    if (!fresh) {
        const code = state.mqttConnected ? "T20" : "T21";
        addRelated("T20"); addRelated("T21");
        return {
            primary: hypothesisCandidate(
                code,
                "LOW",
                "Dashboard đang không nhận được dữ liệu mới từ Central. Hãy kiểm tra nguồn Central, kết nối 4G/Internet và MQTT.",
                state.mqttConnected ? "MQTT của trình duyệt còn kết nối nhưng Central không gửi bản tin mới." : "Trình duyệt cũng đang mất kết nối MQTT."
            ),
            related
        };
    }

    if (!state.node1Online && !state.node2Online) {
        addRelated("T19");
        return { primary: hypothesisCandidate("T19", "HIGH", "Cả hai node đều mất dữ liệu nên hệ thống chưa thể xác định mực nước.", "Node 1: mất kết nối • Node 2: mất kết nối"), related };
    }

    if ((state.node1Online && !state.node2Online) || (!state.node1Online && state.node2Online)) {
        addRelated("T18");
        return { primary: hypothesisCandidate("T18", "HIGH", "Một node đang mất dữ liệu. Hệ thống vẫn theo dõi bằng node còn lại nhưng độ tin cậy sẽ giảm.", `Node 1: ${state.node1Online ? "online" : "offline"} • Node 2: ${state.node2Online ? "online" : "offline"}`), related };
    }

    if (state.scenario === "OBSTRUCTION_SUSPECTED" || state.scenario === "LOCAL_ANOMALY") {
        addRelated("T15");
        return { primary: hypothesisCandidate("T15", "HIGH", "Một cảm biến có thể đang bị tay, xe hoặc vật khác che. Không dùng giá trị này để kết luận ngập.", "Một node đang cho giá trị khác thường so với node còn lại."), related };
    }

    if (state.scenario === "TRANSIENT_ANOMALY") {
        addRelated("T13"); addRelated("T14");
        return { primary: hypothesisCandidate("T13", "MEDIUM", "Có thay đổi ngắn rồi trở lại bình thường. Có thể là nước xuất hiện thoáng qua hoặc vật đi ngang cảm biến.", "Biến động chỉ xuất hiện trong thời gian ngắn."), related };
    }

    if (state.scenario === "PIPE_LEAK_SUSPECTED") {
        addRelated("T26");
        return { primary: hypothesisCandidate("T26", "HIGH", "Không mưa nhưng nước vẫn tồn tại lâu. Đây là dấu hiệu nguồn nước bất thường và cần kiểm tra thêm.", "Không mưa nhưng mực nước không trở về bình thường."), related };
    }

    if (state.scenario === "DRAINAGE_BLOCKED_SUSPECTED") {
        addRelated("T24");
        return { primary: hypothesisCandidate("T24", "HIGH", "Sau mưa, nước không rút như bình thường. Có thể hệ thống thoát nước đang hoạt động kém.", "Mực nước duy trì cao sau giai đoạn mưa."), related };
    }

    if (state.scenario === "DRAINAGE_RECOVERY") {
        addRelated("T23");
        return { primary: hypothesisCandidate("T23", "HIGH", "Mực nước đang giảm trở lại sau khi đã dâng. Hệ thống đang ở giai đoạn nước rút.", "Xu hướng mực nước: đang giảm."), related };
    }

    if (state.raining && (state.trend === "FALLING" || state.trend === "FALLING_FAST")) {
        addRelated("T25"); addRelated("T23");
        return { primary: hypothesisCandidate("T25", "HIGH", "Cảm biến mưa vẫn báo ướt nhưng mực nước đang giảm. Hệ thống ưu tiên diễn biến thực tế của mực nước.", "Đang báo mưa • mực nước đang giảm"), related };
    }

    const rate = state.rateCmPerMin;
    if (rate != null && rate >= 2) {
        addRelated("T09");
        return { primary: hypothesisCandidate("T09", "HIGH", "Mực nước đang dâng nhanh. Hệ thống cần theo dõi sát ngưỡng tiếp theo và cảnh báo sớm nếu đủ điều kiện.", `Tốc độ dâng: ${rate.toFixed(2)} cm/phút`), related };
    }

    if (rate != null && rate >= 0.2 && rate < 1.2 && (state.trend === "RISING" || state.trend === "RISING_FAST")) {
        addRelated("T08");
        return { primary: hypothesisCandidate("T08", "MEDIUM", "Mực nước đang tăng từ từ. Các mức cảnh báo nên thay đổi lần lượt theo độ cao nước.", `Tốc độ dâng: ${rate.toFixed(2)} cm/phút`), related };
    }

    if (["NODE1_TO_NODE2", "NODE1_FIRST"].includes(state.flowDirection)) {
        addRelated("T10");
        return { primary: hypothesisCandidate("T10", "MEDIUM", "Node 1 thấy nước trước Node 2. Trên mô hình, nước có xu hướng xuất hiện từ phía Node 1 trước.", "Node 1 phát hiện nước sớm hơn Node 2."), related };
    }

    if (["NODE2_TO_NODE1", "NODE2_FIRST"].includes(state.flowDirection)) {
        addRelated("T11");
        return { primary: hypothesisCandidate("T11", "MEDIUM", "Node 2 thấy nước trước Node 1. Trên mô hình, nước có xu hướng xuất hiện từ phía Node 2 trước.", "Node 2 phát hiện nước sớm hơn Node 1."), related };
    }

    if (state.flowDirection === "SIMULTANEOUS" && state.maxWaterLevel != null && state.maxWaterLevel >= 3) {
        addRelated("T12");
        return { primary: hypothesisCandidate("T12", "MEDIUM", "Hai node thấy nước gần cùng lúc nên hệ thống không kết luận hướng nước.", "Thời điểm nước xuất hiện tại hai node gần nhau."), related };
    }

    const range8s = recentRange(8000);
    if (range8s && range8s.min >= 6.3 && range8s.max <= 7.7 && range8s.range >= 0.4) {
        addRelated("T16");
        return { primary: hypothesisCandidate("T16", "LOW", "Mực nước đang dao động nhẹ quanh vùng 7 cm, có thể do sóng hoặc mặt nước bị khuấy.", `Trong 8 giây: ${range8s.min.toFixed(1)}–${range8s.max.toFixed(1)} cm`), related };
    }

    const crossings7 = thresholdCrossings(7, 60000);
    const crossings15 = thresholdCrossings(15, 60000);
    if (crossings7 >= 4 || crossings15 >= 4) {
        addRelated("T17");
        const threshold = crossings15 >= crossings7 ? 15 : 7;
        return { primary: hypothesisCandidate("T17", "LOW", "Mực nước đang qua lại nhiều lần quanh một ngưỡng. Hysteresis cần giữ cảnh báo ổn định, tránh bật/tắt liên tục.", `Dao động quanh ngưỡng ${threshold} cm`), related };
    }

    if (state.alertLevel === 4) {
        addRelated("T07");
        return { primary: hypothesisCandidate("T07", "HIGH", "Mực nước đã vào mức cảnh báo 3. Buzzer chỉ được kích hoạt khi hai node cùng hợp lệ và chênh nhau không quá 2 cm.", `Mực nước cao nhất: ${state.maxWaterLevel?.toFixed(1) ?? "--"} cm`), related };
    }
    if (state.alertLevel === 3) {
        addRelated("T06");
        return { primary: hypothesisCandidate("T06", "HIGH", "Mực nước đã đạt vùng cảnh báo mức 2.", `Mực nước cao nhất: ${state.maxWaterLevel?.toFixed(1) ?? "--"} cm`), related };
    }
    if (state.alertLevel === 2) {
        addRelated("T05");
        return { primary: hypothesisCandidate("T05", "HIGH", "Mực nước đã vào vùng nguy cơ và cần tiếp tục theo dõi khả năng dâng thêm.", `Mực nước cao nhất: ${state.maxWaterLevel?.toFixed(1) ?? "--"} cm`), related };
    }
    if (state.alertLevel === 1) {
        addRelated("T04");
        return { primary: hypothesisCandidate("T04", "HIGH", "Mực nước đã đạt ngưỡng cảnh báo mức 1.", `Mực nước cao nhất: ${state.maxWaterLevel?.toFixed(1) ?? "--"} cm`), related };
    }

    if (state.raining && state.alertLevel === 0) {
        addRelated("T23");
        return { primary: hypothesisCandidate("T23", "MEDIUM", "Đang có mưa nhưng mực nước vẫn dưới ngưỡng cảnh báo.", "Cảm biến mưa: có mưa • mức cảnh báo: bình thường"), related };
    }

    if (!state.raining && state.alertLevel === 0 && state.node1MeasurementValid && state.node2MeasurementValid) {
        addRelated("T01");
        return { primary: hypothesisCandidate("T01", "HIGH", "Hai node đang hoạt động bình thường, không mưa và mực nước chưa đạt ngưỡng cảnh báo.", `Mực nước cao nhất: ${state.maxWaterLevel?.toFixed(1) ?? "--"} cm`), related };
    }

    if (state.node1Pdr != null || state.node2Pdr != null) {
        addRelated("T22");
        return { primary: hypothesisCandidate("T22", "LOW", "Chưa khớp rõ với tình huống mực nước nào. Có thể xem chất lượng kết nối ESP-NOW của hai node.", `PDR Node 1: ${state.node1Pdr?.toFixed(1) ?? "--"}% • Node 2: ${state.node2Pdr?.toFixed(1) ?? "--"}%`), related };
    }

    return { primary: hypothesisCandidate("T01", "NONE", "Chưa đủ dữ liệu để xác định tình huống phù hợp.", "Đang chờ thêm dữ liệu từ hệ thống."), related };
}

function renderHypothesisConclusion(fresh) {
    const card = el("hypothesisConclusionCard");
    if (!card) return;

    card.classList.remove("hypothesis-high", "hypothesis-medium", "hypothesis-low", "hypothesis-none");
    const { primary, related } = deriveHypothesis(fresh);
    const conf = confidenceMeta(primary.confidence);
    card.classList.add(conf.cls);

    const badge = el("hypothesisBadge");
    badge.className = `badge ${conf.badge}`;
    badge.textContent = conf.text.toUpperCase();

    el("hypothesisTestCode").textContent = primary.code || "T--";
    el("hypothesisTitle").textContent = primary.meta?.title || "Chưa xác định";
    el("hypothesisConclusion").textContent = primary.conclusion;
    el("hypothesisEvidence").textContent = primary.evidence || "--";
    el("hypothesisConfidence").textContent = conf.text;
    el("hypothesisRelated").textContent = related.length ? related.join(" / ") : primary.code || "--";
    el("hypothesisTime").textContent = nowTime();
}

function renderTestCaseCatalog() {
    const host = el("testCaseCatalog");
    if (!host || host.dataset.ready === "1") return;
    host.dataset.ready = "1";
    Object.entries(TEST_CASES).forEach(([code, item]) => {
        const div = document.createElement("div");
        div.className = "scenario-catalog-item";
        const autoText = item.auto === true ? "Theo dõi tự động" : item.auto === "limited" ? "Chỉ tham khảo" : "Cần thử trực tiếp";
        div.innerHTML = `<div class="scenario-catalog-head"><code>${code}</code><span>${TEST_GROUP_NAMES[item.group] || item.group}</span></div>` +
            `<strong>${item.title}</strong>` +
            `<p>${item.expected}</p>` +
            `<small>${autoText}</small>`;
        host.appendChild(div);
    });
}

const state = {
    mqttConnected: false,
    lastMessageAt: 0,
    node1Distance: null,
    node2Distance: null,
    node1WaterLevel: null,
    node2WaterLevel: null,
    maxWaterLevel: null,
    node1Online: false,
    node2Online: false,
    node1MeasurementValid: false,
    node2MeasurementValid: false,
    monitoringDegraded: true,
    raining: false,
    alertLevel: 0,
    scenario: "WAITING",
    trend: "UNKNOWN",
    rateCmPerMin: null,
    nextThresholdCm: null,
    etaSeconds: null,
    earlyWarning: false,
    earlyWarningCode: "NONE",
    flowDirection: "UNDETERMINED",
    node1Pdr: null,
    node2Pdr: null,
    previousEarlyWarning: null,
    previousNode1Online: null,
    previousNode2Online: null,
    previousRaining: null,
    previousScenario: null,
    previousAlertLevel: null,
    previousCentralFresh: null
};

function el(id) {
    return document.getElementById(id);
}

function nowTime() {
    return new Date().toLocaleTimeString("vi-VN");
}

function updateClock() {
    el("clock").textContent = new Date().toLocaleString("vi-VN");
}
setInterval(updateClock, 1000);
updateClock();

function numberOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function boolValue(value) {
    return value === true || value === 1 || value === "1" || value === "true";
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function waterFromDistance(distance) {
    if (distance == null) return null;
    return clamp(SENSOR_HEIGHT_CM - distance, 0, SENSOR_HEIGHT_CM);
}

function deriveAlertLevel(maxWater) {
    if (maxWater == null) return 0;
    if (maxWater >= 15) return 4;
    if (maxWater >= 10) return 3;
    if (maxWater >= 7) return 2;
    if (maxWater >= 3) return 1;
    return 0;
}

function deriveScenario() {
    if (!state.node1Online && !state.node2Online) return "NODES_OFFLINE";
    if (state.monitoringDegraded) return "NODE_DEGRADED";
    if (state.raining && state.alertLevel === 0) return "RAIN_NO_FLOOD";
    if (state.alertLevel === 4) return "FLOOD_LEVEL_3";
    if (state.alertLevel === 3) return "FLOOD_LEVEL_2";
    if (state.alertLevel === 2) return "FLOOD_LEVEL_1_RISK_2";
    if (state.alertLevel === 1) return "FLOOD_LEVEL_1";
    return "NORMAL_DRY";
}

function isCentralFresh() {
    return state.lastMessageAt > 0 && (Date.now() - state.lastMessageAt) <= MQTT_CONFIG.centralTimeoutMs;
}

function normalizePayload(data) {
    const node1Distance = numberOrNull(data.node1Distance);
    const node2Distance = numberOrNull(data.node2Distance);

    const node1Online = boolValue(data.node1Online);
    const node2Online = boolValue(data.node2Online);

    let node1WaterLevel = numberOrNull(data.node1WaterLevel);
    let node2WaterLevel = numberOrNull(data.node2WaterLevel);

    // Tương thích payload v1.2 nếu Central cũ chưa gửi waterLevel.
    if (node1WaterLevel == null && node1Online) node1WaterLevel = waterFromDistance(node1Distance);
    if (node2WaterLevel == null && node2Online) node2WaterLevel = waterFromDistance(node2Distance);

    let node1Valid = data.node1MeasurementValid == null
        ? node1Online && node1Distance != null
        : boolValue(data.node1MeasurementValid);
    let node2Valid = data.node2MeasurementValid == null
        ? node2Online && node2Distance != null
        : boolValue(data.node2MeasurementValid);

    if (!node1Online) node1Valid = false;
    if (!node2Online) node2Valid = false;

    let maxWater = numberOrNull(data.maxWaterLevel);
    if (maxWater == null) {
        const candidates = [];
        if (node1Valid && node1WaterLevel != null) candidates.push(node1WaterLevel);
        if (node2Valid && node2WaterLevel != null) candidates.push(node2WaterLevel);
        maxWater = candidates.length ? Math.max(...candidates) : 0;
    }

    const alertLevelRaw = Number(data.alertLevel);
    const alertLevel = Number.isInteger(alertLevelRaw) && alertLevelRaw >= 0 && alertLevelRaw <= 4
        ? alertLevelRaw
        : deriveAlertLevel(maxWater);

    return {
        node1Distance,
        node2Distance,
        node1WaterLevel,
        node2WaterLevel,
        maxWaterLevel: maxWater,
        node1Online,
        node2Online,
        node1MeasurementValid: node1Valid,
        node2MeasurementValid: node2Valid,
        monitoringDegraded: data.monitoringDegraded == null
            ? !(node1Valid && node2Valid)
            : boolValue(data.monitoringDegraded),
        raining: boolValue(data.raining),
        alertLevel,
        scenario: typeof data.scenario === "string" && data.scenario.trim()
            ? data.scenario.trim().toUpperCase()
            : null,
        trend: typeof data.trend === "string" ? data.trend.trim().toUpperCase() : "UNKNOWN",
        rateCmPerMin: numberOrNull(data.rateCmPerMin),
        nextThresholdCm: numberOrNull(data.nextThresholdCm),
        etaSeconds: Number.isFinite(Number(data.etaSeconds)) && Number(data.etaSeconds) >= 0 ? Math.round(Number(data.etaSeconds)) : null,
        earlyWarning: boolValue(data.earlyWarning),
        earlyWarningCode: typeof data.earlyWarningCode === "string" ? data.earlyWarningCode.trim().toUpperCase() : "NONE",
        flowDirection: typeof data.flowDirection === "string" ? data.flowDirection.trim().toUpperCase() : "UNDETERMINED",
        node1Pdr: numberOrNull(data.node1Pdr),
        node2Pdr: numberOrNull(data.node2Pdr)
    };
}

// ===================== CHART =====================
const realtimeLabels = [];
const node1Series = [];
const node2Series = [];

const waterChart = new Chart(el("waterChart"), {
    type: "line",
    data: {
        labels: realtimeLabels,
        datasets: [
            {
                label: "Node 1 - Mực nước",
                data: node1Series,
                borderColor: "#1976d2",
                backgroundColor: "rgba(25,118,210,.12)",
                borderWidth: 2.5,
                tension: .25,
                fill: false,
                spanGaps: true
            },
            {
                label: "Node 2 - Mực nước",
                data: node2Series,
                borderColor: "#f59e0b",
                backgroundColor: "rgba(245,158,11,.12)",
                borderWidth: 2.5,
                tension: .25,
                fill: false,
                spanGaps: true
            }
        ]
    },
    options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        interaction: { intersect: false, mode: "index" },
        plugins: { legend: { position: "top" } },
        scales: {
            y: {
                beginAtZero: true,
                suggestedMax: 20,
                title: { display: true, text: "Mực nước (cm)" }
            },
            x: {
                title: { display: true, text: "Thời gian" },
                ticks: { maxTicksLimit: 12 }
            }
        }
    }
});

function pushChartPoint() {
    realtimeLabels.push(nowTime());
    node1Series.push(state.node1Online && state.node1MeasurementValid ? state.node1WaterLevel : null);
    node2Series.push(state.node2Online && state.node2MeasurementValid ? state.node2WaterLevel : null);

    while (realtimeLabels.length > CHART_MAX_POINTS) {
        realtimeLabels.shift();
        node1Series.shift();
        node2Series.shift();
    }
    waterChart.update();
}

// ===================== EVENT LOG =====================
function addEvent(message, status = "INFO", badgeClass = "bg-primary") {
    const body = el("eventTableBody");
    const row = document.createElement("tr");

    const timeCell = document.createElement("td");
    timeCell.textContent = nowTime();

    const messageCell = document.createElement("td");
    messageCell.textContent = message;

    const statusCell = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = `badge ${badgeClass}`;
    badge.textContent = status;
    statusCell.appendChild(badge);

    row.append(timeCell, messageCell, statusCell);
    body.prepend(row);

    while (body.children.length > 10) body.removeChild(body.lastElementChild);
}

// ===================== NODE UI =====================
function waterBarClass(level) {
    if (level >= 15) return "bar-danger";
    if (level >= 7) return "bar-warning";
    return "bar-normal";
}

function setNodeCard(nodeNumber, distance, waterLevel, online, valid, fresh) {
    const badge = el(`node${nodeNumber}StatusBadge`);
    const water = el(`node${nodeNumber}WaterLevel`);
    const distanceEl = el(`node${nodeNumber}Distance`);
    const validity = el(`node${nodeNumber}Validity`);
    const time = el(`node${nodeNumber}Time`);
    const bar = el(`node${nodeNumber}Bar`);

    if (!fresh) {
        badge.className = "badge bg-secondary";
        badge.textContent = "Không xác định";
        water.textContent = "-- cm";
        distanceEl.textContent = "-- cm";
        validity.textContent = "--";
        bar.className = "progress-bar";
        bar.style.width = "0%";
        bar.textContent = "--";
        return;
    }

    if (!online) {
        badge.className = "badge bg-danger";
        badge.textContent = "Ngoại tuyến";
        water.textContent = "-- cm";
        distanceEl.textContent = "-- cm";
        validity.textContent = "Không có dữ liệu";
        bar.className = "progress-bar bar-offline";
        bar.style.width = "0%";
        bar.textContent = "OFF";
        return;
    }

    badge.className = "badge bg-success";
    badge.textContent = "Trực tuyến";
    time.textContent = nowTime();
    distanceEl.textContent = distance == null ? "-- cm" : `${distance.toFixed(1)} cm`;

    if (!valid || waterLevel == null) {
        water.textContent = "INVALID";
        validity.textContent = "Không hợp lệ";
        validity.className = "text-danger";
        bar.className = "progress-bar bar-offline";
        bar.style.width = "0%";
        bar.textContent = "INVALID";
        return;
    }

    water.textContent = `${waterLevel.toFixed(1)} cm`;
    validity.textContent = "Hợp lệ";
    validity.className = "text-success";
    const percent = clamp(waterLevel / WATER_VISUAL_MAX_CM * 100, 0, 100);
    bar.className = `progress-bar ${waterBarClass(waterLevel)}`;
    bar.style.width = `${percent}%`;
    bar.textContent = `${waterLevel.toFixed(1)} cm`;
}

function setMaxLevelUI(fresh) {
    const maxWater = fresh && state.maxWaterLevel != null ? state.maxWaterLevel : null;
    el("maxWaterLevel").textContent = maxWater == null ? "-- cm" : `${maxWater.toFixed(1)} cm`;

    const meta = ALERT_LEVEL_META[state.alertLevel] || ALERT_LEVEL_META[0];
    const badge = el("alertLevelBadge");
    badge.className = `badge ${fresh ? meta.badge : "bg-secondary"}`;
    badge.textContent = fresh ? `L${state.alertLevel}` : "WAIT";
    el("alertLevelText").textContent = fresh ? `${state.alertLevel} - ${meta.label}` : "--";
    el("monitoringState").textContent = fresh
        ? (state.monitoringDegraded ? "Suy giảm" : "Đầy đủ")
        : "--";
    el("monitoringState").className = fresh && state.monitoringDegraded ? "text-warning" : "text-success";

    const markerPercent = maxWater == null ? 0 : clamp(maxWater / WATER_VISUAL_MAX_CM * 100, 0, 100);
    el("maxLevelMarker").style.left = `${markerPercent}%`;
}

function updateEnvironment(fresh) {
    const rainBadge = el("rainBadge");
    if (!fresh) {
        rainBadge.className = "badge bg-secondary";
        rainBadge.textContent = "--";
        el("rainStatus").textContent = "--";
    } else if (state.raining) {
        rainBadge.className = "badge bg-primary";
        rainBadge.textContent = "ĐANG MƯA";
        el("rainStatus").textContent = "Có mưa";
    } else {
        rainBadge.className = "badge bg-success";
        rainBadge.textContent = "KHÔ";
        el("rainStatus").textContent = "Không mưa";
    }

    el("mqttTextStatus").textContent = state.mqttConnected ? "Connected" : "Disconnected";
    el("centralTextStatus").textContent = fresh ? "Online" : "Offline / Timeout";
}

function updateScenarioPanel(fresh) {
    const panel = el("alertPanel");
    panel.classList.remove("alert-normal", "alert-info", "alert-warning-1", "alert-warning-2", "alert-danger", "alert-offline");

    if (!fresh) {
        panel.classList.add("alert-offline");
        el("alertIcon").textContent = "×";
        el("alertTitle").textContent = "CENTRAL KHÔNG CÓ DỮ LIỆU";
        el("alertMessage").textContent = "Không nhận được bản tin MQTT mới từ ESP32 Central. Kiểm tra nguồn Central, Wi-Fi, broker MQTT và kết nối Internet.";
        el("scenarioCode").textContent = "CENTRAL_OFFLINE";
        el("scenarioNode1").textContent = "-- cm";
        el("scenarioNode2").textContent = "-- cm";
        el("nodeDifference").textContent = "-- cm";
        el("alertTime").textContent = nowTime();
        return;
    }

    const meta = SCENARIO_META[state.scenario] || {
        title: "Trạng thái chưa định nghĩa",
        message: "Central gửi một mã scenario mà Dashboard v1.5.0 chưa có mô tả. Mã gốc vẫn được hiển thị để kiểm tra.",
        severity: "UNKNOWN",
        badge: "bg-secondary",
        panel: "alert-info",
        icon: "?"
    };

    panel.classList.add(meta.panel);
    el("alertIcon").textContent = meta.icon;
    el("alertTitle").textContent = meta.title;
    el("alertMessage").textContent = meta.message;
    el("scenarioCode").textContent = state.scenario;
    el("scenarioNode1").textContent = state.node1MeasurementValid && state.node1WaterLevel != null ? `${state.node1WaterLevel.toFixed(1)} cm` : "-- cm";
    el("scenarioNode2").textContent = state.node2MeasurementValid && state.node2WaterLevel != null ? `${state.node2WaterLevel.toFixed(1)} cm` : "-- cm";

    if (state.node1MeasurementValid && state.node2MeasurementValid && state.node1WaterLevel != null && state.node2WaterLevel != null) {
        el("nodeDifference").textContent = `${Math.abs(state.node1WaterLevel - state.node2WaterLevel).toFixed(1)} cm`;
    } else {
        el("nodeDifference").textContent = "-- cm";
    }
    el("alertTime").textContent = nowTime();
}

function trendText(code) {
    const map = {
        RISING_FAST: "↑ Tăng nhanh",
        RISING: "↑ Đang tăng",
        STABLE: "→ Ổn định",
        FALLING: "↓ Đang giảm",
        FALLING_FAST: "↓ Giảm nhanh",
        UNKNOWN: "Chưa đủ dữ liệu"
    };
    return map[code] || code || "--";
}

function flowText(code) {
    const map = {
        NODE1_TO_NODE2: "Node 1 → Node 2",
        NODE2_TO_NODE1: "Node 2 → Node 1",
        NODE1_FIRST: "Node 1 tăng trước",
        NODE2_FIRST: "Node 2 tăng trước",
        SIMULTANEOUS: "Gần đồng thời",
        UNDETERMINED: "Chưa xác định"
    };
    return map[code] || code || "--";
}

function etaDisplay(seconds) {
    if (seconds == null || !Number.isFinite(Number(seconds)) || Number(seconds) < 0) return "Chưa ước tính";
    const total = Math.round(Number(seconds));
    if (total < 60) return `${total} giây`;
    const m = Math.floor(total / 60);
    const s = total % 60;
    return s ? `${m} phút ${s} giây` : `${m} phút`;
}

function renderSensorEarlyWarning(fresh) {
    const card = el("earlyWarningCard");
    const badge = el("earlyWarningBadge");
    if (!card || !badge) return;

    card.classList.remove("warning-danger", "warning-high", "warning-medium", "warning-low", "warning-limited");

    if (!fresh) {
        card.classList.add("warning-limited");
        badge.className = "badge bg-secondary";
        badge.textContent = "CHỜ DỮ LIỆU";
        el("earlyWarningRisk").textContent = "--";
        el("earlyWarningMessage").textContent = "Đang chờ telemetry từ ESP32 Central.";
    } else if (state.earlyWarning) {
        card.classList.add(state.trend === "RISING_FAST" ? "warning-danger" : "warning-high");
        badge.className = `badge ${state.trend === "RISING_FAST" ? "bg-danger" : "bg-warning text-dark"}`;
        badge.textContent = state.trend === "RISING_FAST" ? "TĂNG NHANH" : "EARLY WARNING";
        el("earlyWarningRisk").textContent = "NGUY CƠ SỚM";
        const target = state.nextThresholdCm == null ? "ngưỡng tiếp theo" : `${state.nextThresholdCm.toFixed(0)} cm`;
        el("earlyWarningMessage").textContent = `Mực nước đang tăng ổn định. Nếu xu hướng hiện tại tiếp tục, hệ thống ước tính đạt ${target} sau ${etaDisplay(state.etaSeconds)}.`;
    } else if (state.trend === "RISING" || state.trend === "RISING_FAST") {
        card.classList.add("warning-medium");
        badge.className = "badge bg-info text-dark";
        badge.textContent = "ĐANG THEO DÕI";
        el("earlyWarningRisk").textContent = "XU HƯỚNG TĂNG";
        el("earlyWarningMessage").textContent = "Mực nước đang tăng nhưng chưa thỏa đồng thời điều kiện xác nhận xu hướng và cửa sổ ETA để kích hoạt cảnh báo sớm.";
    } else {
        card.classList.add("warning-low");
        badge.className = "badge bg-success";
        badge.textContent = "CHƯA KÍCH HOẠT";
        el("earlyWarningRisk").textContent = state.trend === "FALLING" || state.trend === "FALLING_FAST" ? "ĐANG GIẢM" : "ỔN ĐỊNH";
        el("earlyWarningMessage").textContent = "Chưa phát hiện xu hướng dâng đủ điều kiện để phát cảnh báo sớm.";
    }

    el("waterRate").textContent = state.rateCmPerMin == null
        ? "-- cm/phút"
        : `${state.rateCmPerMin >= 0 ? "+" : ""}${state.rateCmPerMin.toFixed(2)} cm/phút`;
    el("waterTrend").textContent = trendText(state.trend);
    el("nextThreshold").textContent = state.nextThresholdCm == null ? "--" : `${state.nextThresholdCm.toFixed(0)} cm`;
    el("etaNext").textContent = etaDisplay(state.etaSeconds);
    el("flowDirection").textContent = flowText(state.flowDirection);
}

function updateDeviceTable(fresh) {
    const setDevice = (node, online, valid, water) => {
        el(`deviceNode${node}Status`).textContent = !fresh ? "⚪ Không xác định" : online ? "🟢 ONLINE" : "🔴 OFFLINE";
        el(`deviceNode${node}Valid`).textContent = !fresh ? "--" : !online ? "Không có dữ liệu" : valid ? "Hợp lệ" : "Không hợp lệ";
        el(`deviceNode${node}Value`).textContent = fresh && online && valid && water != null ? `${water.toFixed(1)} cm` : "--";
        if (fresh && online) el(`deviceNode${node}Time`).textContent = nowTime();
    };

    setDevice(1, state.node1Online, state.node1MeasurementValid, state.node1WaterLevel);
    setDevice(2, state.node2Online, state.node2MeasurementValid, state.node2WaterLevel);

    el("deviceCentralStatus").textContent = fresh ? "🟢 ONLINE" : "🔴 OFFLINE";
    el("deviceCentralValue").textContent = state.mqttConnected ? "MQTT Connected" : "MQTT Disconnected";
    if (fresh) el("deviceCentralTime").textContent = nowTime();
}

function updateHeader(fresh) {
    const mqttBadge = el("mqttStatusBadge");
    mqttBadge.className = `badge ${state.mqttConnected ? "bg-success" : "bg-danger"}`;
    mqttBadge.textContent = `MQTT: ${state.mqttConnected ? "Connected" : "Disconnected"}`;

    const centralBadge = el("centralStatusBadge");
    centralBadge.className = `badge ${fresh ? "bg-success" : "bg-danger"}`;
    centralBadge.textContent = `Central: ${fresh ? "Online" : "Offline"}`;
}

function renderAll() {
    const fresh = isCentralFresh();
    updateHeader(fresh);
    setNodeCard(1, state.node1Distance, state.node1WaterLevel, state.node1Online, state.node1MeasurementValid, fresh);
    setNodeCard(2, state.node2Distance, state.node2WaterLevel, state.node2Online, state.node2MeasurementValid, fresh);
    setMaxLevelUI(fresh);
    updateEnvironment(fresh);
    updateScenarioPanel(fresh);
    renderSensorEarlyWarning(fresh);
    renderHypothesisConclusion(fresh);
    renderTestCaseCatalog();
    updateDeviceTable(fresh);

    if (state.previousCentralFresh !== fresh) {
        if (state.previousCentralFresh !== null) {
            addEvent(
                fresh ? "ESP32 Central có dữ liệu trở lại" : "Mất dữ liệu từ ESP32 Central",
                fresh ? "ONLINE" : "OFFLINE",
                fresh ? "bg-success" : "bg-danger"
            );
        }
        state.previousCentralFresh = fresh;
    }
}

function detectStateChanges() {
    if (state.previousNode1Online !== null && state.previousNode1Online !== state.node1Online) {
        addEvent(`Node 1 ${state.node1Online ? "đã kết nối" : "mất kết nối"}`, state.node1Online ? "ONLINE" : "OFFLINE", state.node1Online ? "bg-success" : "bg-warning text-dark");
    }
    if (state.previousNode2Online !== null && state.previousNode2Online !== state.node2Online) {
        addEvent(`Node 2 ${state.node2Online ? "đã kết nối" : "mất kết nối"}`, state.node2Online ? "ONLINE" : "OFFLINE", state.node2Online ? "bg-success" : "bg-warning text-dark");
    }
    if (state.previousRaining !== null && state.previousRaining !== state.raining) {
        addEvent(state.raining ? "Cảm biến phát hiện mưa" : "Cảm biến mưa trở về trạng thái khô", state.raining ? "RAIN" : "DRY", state.raining ? "bg-primary" : "bg-success");
    }
    if (state.previousScenario !== null && state.previousScenario !== state.scenario) {
        const meta = SCENARIO_META[state.scenario];
        addEvent(meta ? meta.title : state.scenario, meta ? meta.severity : "SCENARIO", meta ? meta.badge : "bg-secondary");
    }
    if (state.previousAlertLevel !== null && state.previousAlertLevel !== state.alertLevel) {
        const meta = ALERT_LEVEL_META[state.alertLevel] || ALERT_LEVEL_META[0];
        addEvent(`Mức cảnh báo chuyển sang ${state.alertLevel} - ${meta.label}`, `L${state.alertLevel}`, meta.badge);
    }
    if (state.previousEarlyWarning !== null && state.previousEarlyWarning !== state.earlyWarning) {
        addEvent(
            state.earlyWarning ? `Kích hoạt cảnh báo sớm tới ngưỡng ${state.nextThresholdCm ?? "--"} cm` : "Kết thúc cảnh báo sớm",
            state.earlyWarning ? "EARLY" : "CLEAR",
            state.earlyWarning ? "bg-warning text-dark" : "bg-success"
        );
    }

    state.previousEarlyWarning = state.earlyWarning;
    state.previousNode1Online = state.node1Online;
    state.previousNode2Online = state.node2Online;
    state.previousRaining = state.raining;
    state.previousScenario = state.scenario;
    state.previousAlertLevel = state.alertLevel;
}

function applyPayload(data) {
    const normalized = normalizePayload(data);
    Object.assign(state, normalized);
    if (!state.scenario) state.scenario = deriveScenario();
    state.lastMessageAt = Date.now();
    pushHypothesisHistory();
    detectStateChanges();
    pushChartPoint();
    renderAll();
}

// ===================== MQTT =====================
const WEB_MQTT_ENABLED = window.FLOODGUARD_WEB_MQTT_ENABLED !== false;
let mqttClient;
if (WEB_MQTT_ENABLED) {
try {
    mqttClient = mqtt.connect(MQTT_CONFIG.url, {
        clientId: `FloodWeb_${Math.random().toString(16).slice(2, 10)}`,
        clean: true,
        reconnectPeriod: MQTT_CONFIG.reconnectPeriod,
        connectTimeout: 10000
    });

    mqttClient.on("connect", () => {
        state.mqttConnected = true;
        addEvent("Dashboard kết nối MQTT Broker", "MQTT", "bg-success");
        mqttClient.subscribe(MQTT_CONFIG.topic, { qos: 0 }, error => {
            if (error) {
                console.error("MQTT subscribe failed:", error);
                addEvent("Subscribe MQTT thất bại", "ERROR", "bg-danger");
            }
        });
        renderAll();
    });

    mqttClient.on("reconnect", () => {
        state.mqttConnected = false;
        renderAll();
    });

    mqttClient.on("close", () => {
        state.mqttConnected = false;
        renderAll();
    });

    mqttClient.on("offline", () => {
        state.mqttConnected = false;
        renderAll();
    });

    mqttClient.on("error", error => {
        console.error("MQTT error:", error);
        state.mqttConnected = false;
        renderAll();
    });

    mqttClient.on("message", (topic, payload) => {
        if (topic !== MQTT_CONFIG.topic) return;
        try {
            const data = JSON.parse(payload.toString());
            applyPayload(data);
        } catch (error) {
            console.error("Invalid MQTT payload:", error);
            addEvent("Payload MQTT không hợp lệ", "ERROR", "bg-danger");
        }
    });
} catch (error) {
    console.error("MQTT initialization failed:", error);
    state.mqttConnected = false;
}
} else {
    state.mqttConnected = false;
    addEvent("Dashboard MQTT tạm tắt", "MQTT OFF", "bg-secondary");
    console.log("[MQTT] Dashboard connection disabled by WEB_MQTT_ENABLED=false");
}

// Kiểm tra timeout Central liên tục, không phụ thuộc có bản tin mới.
setInterval(renderAll, 1000);
renderAll();