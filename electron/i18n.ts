import { app } from "electron";
import type { AppLanguage } from "./types";

type ResolvedLanguage = Exclude<AppLanguage, "system">;

const supported: readonly ResolvedLanguage[] = [
  "zh-CN", "zh-TW", "en-US", "ja-JP", "ko-KR", "es-ES", "fr-FR", "de-DE",
  "pt-BR", "ru-RU", "ar-SA", "hi-IN", "id-ID", "it-IT", "tr-TR"
];

export function resolveNativeLanguage(language: AppLanguage): ResolvedLanguage {
  if (language !== "system") return language;
  const locale = app.getLocale().toLowerCase();
  if (locale.startsWith("zh-hant") || ["zh-tw", "zh-hk", "zh-mo"].includes(locale)) return "zh-TW";
  if (locale.startsWith("zh")) return "zh-CN";
  const exact = supported.find((item) => item.toLowerCase() === locale);
  if (exact) return exact;
  const prefix = locale.split("-")[0];
  return supported.find((item) => item.toLowerCase().startsWith(`${prefix}-`)) ?? "en-US";
}

const english = {
  tagline: "Whole-disk search and safe AI migration",
  quickWindow: "CDriveShiftAI Quick Search",
  uninstallWindow: "CDriveShiftAI · Restore before uninstall",
  open: "Open CDriveShiftAI",
  quickSearch: "Standalone quick search",
  quickFunctions: "Quick actions",
  overview: "Space overview",
  search: "Fast search",
  ownership: "Disk ownership map",
  analyze: "AI ownership analysis",
  migrate: "Safe migration",
  history: "Migration history",
  aiService: "AI service",
  enabled: "Enabled",
  paused: "Paused",
  notTested: "Connection test not completed",
  configureAi: "Configure URL, key, and model…",
  theme: "Interface theme",
  settings: "Settings and shortcuts",
  exit: "Exit",
  unableAi: "Unable to switch AI service",
  aurora: "Pixel · Pixel Lake",
  matrix: "Tech · HUD data flow",
  calm: "Crystal · Frosted glow",
  ember: "Ember · Ember Hive",
  ivory: "Ivory · Warm porcelain"
} as const;

type NativeStrings = { [Key in keyof typeof english]: string };
type NativeOverrides = Partial<NativeStrings>;

const overrides: Record<ResolvedLanguage, NativeOverrides> = {
  "en-US": {},
  "zh-CN": {
    tagline: "全盘 AI 智迁", quickWindow: "CDriveShiftAI 极速搜索", uninstallWindow: "CDriveShiftAI · 卸载前恢复", open: "打开 CDriveShiftAI", quickSearch: "独立极速搜索", quickFunctions: "快速功能", overview: "空间总览", search: "极速搜索", ownership: "磁盘归属地图", analyze: "AI 归属分析", migrate: "安全迁移", history: "迁移记录", aiService: "AI 服务", enabled: "已启用", paused: "已暂停", notTested: "尚未完成连接测试", configureAi: "配置 URL、Key 与模型…", theme: "界面主题", settings: "设置与快捷键", exit: "退出", unableAi: "无法切换 AI 服务", aurora: "方块 · 像素湖境", matrix: "科技 · HUD 数据流", calm: "晶境 · 玻璃流光", ember: "熔橙 · 熔芯蜂巢", ivory: "暖瓷 · 米白陶影"
  },
  "zh-TW": {
    tagline: "全碟 AI 智慧搬移", quickWindow: "CDriveShiftAI 快速搜尋", uninstallWindow: "CDriveShiftAI · 解除安裝前還原", open: "開啟 CDriveShiftAI", quickSearch: "獨立快速搜尋", quickFunctions: "快速功能", overview: "空間總覽", search: "快速搜尋", ownership: "磁碟歸屬地圖", analyze: "AI 歸屬分析", migrate: "安全搬移", history: "搬移記錄", aiService: "AI 服務", enabled: "已啟用", paused: "已暫停", notTested: "尚未完成連線測試", configureAi: "設定 URL、Key 與模型…", theme: "介面主題", settings: "設定與快速鍵", exit: "結束", unableAi: "無法切換 AI 服務"
  },
  "ja-JP": { tagline: "全ドライブ検索と安全な AI 移行", quickWindow: "CDriveShiftAI クイック検索", open: "CDriveShiftAI を開く", quickSearch: "クイック検索", quickFunctions: "クイック操作", overview: "容量概要", search: "高速検索", ownership: "ディスク所有マップ", analyze: "AI 所有分析", migrate: "安全な移行", history: "移行履歴", aiService: "AI サービス", enabled: "有効", paused: "一時停止", notTested: "接続テスト未完了", configureAi: "URL・キー・モデルを設定…", theme: "テーマ", settings: "設定とショートカット", exit: "終了", unableAi: "AI サービスを切り替えられません" },
  "ko-KR": { tagline: "전체 디스크 검색과 안전한 AI 마이그레이션", quickWindow: "CDriveShiftAI 빠른 검색", open: "CDriveShiftAI 열기", quickSearch: "독립 빠른 검색", quickFunctions: "빠른 기능", overview: "공간 개요", search: "빠른 검색", ownership: "디스크 소유권 지도", analyze: "AI 소유권 분석", migrate: "안전한 이동", history: "이동 기록", aiService: "AI 서비스", enabled: "사용", paused: "일시 중지", notTested: "연결 테스트 미완료", configureAi: "URL, 키 및 모델 설정…", theme: "화면 테마", settings: "설정 및 바로가기", exit: "종료", unableAi: "AI 서비스를 전환할 수 없음" },
  "es-ES": { tagline: "Búsqueda en todos los discos y migración segura con IA", quickWindow: "Búsqueda rápida de CDriveShiftAI", open: "Abrir CDriveShiftAI", quickSearch: "Búsqueda rápida", quickFunctions: "Acciones rápidas", overview: "Resumen de espacio", search: "Búsqueda rápida", ownership: "Mapa de propiedad", analyze: "Análisis con IA", migrate: "Migración segura", history: "Historial", aiService: "Servicio de IA", enabled: "Activado", paused: "Pausado", notTested: "Prueba de conexión pendiente", configureAi: "Configurar URL, clave y modelo…", theme: "Tema de interfaz", settings: "Configuración y atajos", exit: "Salir", unableAi: "No se pudo cambiar el servicio de IA" },
  "fr-FR": { tagline: "Recherche sur tous les disques et migration IA sécurisée", quickWindow: "Recherche rapide CDriveShiftAI", open: "Ouvrir CDriveShiftAI", quickSearch: "Recherche rapide", quickFunctions: "Actions rapides", overview: "Vue de l’espace", search: "Recherche rapide", ownership: "Carte d’appartenance", analyze: "Analyse par IA", migrate: "Migration sécurisée", history: "Historique", aiService: "Service IA", enabled: "Activé", paused: "En pause", notTested: "Test de connexion non terminé", configureAi: "Configurer l’URL, la clé et le modèle…", theme: "Thème de l’interface", settings: "Paramètres et raccourcis", exit: "Quitter", unableAi: "Impossible de changer de service IA" },
  "de-DE": { tagline: "Laufwerksweite Suche und sichere KI-Migration", quickWindow: "CDriveShiftAI Schnellsuche", open: "CDriveShiftAI öffnen", quickSearch: "Schnellsuche", quickFunctions: "Schnellaktionen", overview: "Speicherübersicht", search: "Schnellsuche", ownership: "Zuordnungskarte", analyze: "KI-Zuordnungsanalyse", migrate: "Sichere Migration", history: "Migrationsverlauf", aiService: "KI-Dienst", enabled: "Aktiviert", paused: "Pausiert", notTested: "Verbindungstest nicht abgeschlossen", configureAi: "URL, Schlüssel und Modell einrichten…", theme: "Oberflächenthema", settings: "Einstellungen und Tastenkürzel", exit: "Beenden", unableAi: "KI-Dienst konnte nicht gewechselt werden" },
  "pt-BR": { tagline: "Busca em todos os discos e migração segura com IA", quickWindow: "Busca rápida do CDriveShiftAI", open: "Abrir CDriveShiftAI", quickSearch: "Busca rápida", quickFunctions: "Ações rápidas", overview: "Visão do espaço", search: "Busca rápida", ownership: "Mapa de propriedade", analyze: "Análise por IA", migrate: "Migração segura", history: "Histórico", aiService: "Serviço de IA", enabled: "Ativado", paused: "Pausado", notTested: "Teste de conexão pendente", configureAi: "Configurar URL, chave e modelo…", theme: "Tema da interface", settings: "Configurações e atalhos", exit: "Sair", unableAi: "Não foi possível trocar o serviço de IA" },
  "ru-RU": { tagline: "Поиск по всем дискам и безопасный перенос с ИИ", quickWindow: "Быстрый поиск CDriveShiftAI", open: "Открыть CDriveShiftAI", quickSearch: "Быстрый поиск", quickFunctions: "Быстрые действия", overview: "Обзор места", search: "Быстрый поиск", ownership: "Карта принадлежности", analyze: "Анализ с ИИ", migrate: "Безопасный перенос", history: "История", aiService: "Сервис ИИ", enabled: "Включён", paused: "Приостановлен", notTested: "Проверка подключения не завершена", configureAi: "Настроить URL, ключ и модель…", theme: "Тема интерфейса", settings: "Настройки и сочетания клавиш", exit: "Выход", unableAi: "Не удалось сменить сервис ИИ" },
  "ar-SA": { tagline: "بحث في جميع الأقراص ونقل آمن بالذكاء الاصطناعي", quickWindow: "بحث CDriveShiftAI السريع", open: "فتح CDriveShiftAI", quickSearch: "بحث سريع", quickFunctions: "إجراءات سريعة", overview: "نظرة على المساحة", search: "بحث سريع", ownership: "خريطة الملكية", analyze: "تحليل بالذكاء الاصطناعي", migrate: "نقل آمن", history: "سجل النقل", aiService: "خدمة الذكاء الاصطناعي", enabled: "مفعّل", paused: "متوقف مؤقتًا", notTested: "اختبار الاتصال غير مكتمل", configureAi: "إعداد الرابط والمفتاح والنموذج…", theme: "سمة الواجهة", settings: "الإعدادات والاختصارات", exit: "خروج", unableAi: "تعذر تبديل خدمة الذكاء الاصطناعي" },
  "hi-IN": { tagline: "सभी डिस्क में खोज और सुरक्षित AI माइग्रेशन", quickWindow: "CDriveShiftAI त्वरित खोज", open: "CDriveShiftAI खोलें", quickSearch: "त्वरित खोज", quickFunctions: "त्वरित क्रियाएँ", overview: "स्थान अवलोकन", search: "तेज़ खोज", ownership: "स्वामित्व मानचित्र", analyze: "AI विश्लेषण", migrate: "सुरक्षित माइग्रेशन", history: "इतिहास", aiService: "AI सेवा", enabled: "सक्रिय", paused: "रोका गया", notTested: "कनेक्शन परीक्षण अधूरा", configureAi: "URL, कुंजी और मॉडल कॉन्फ़िगर करें…", theme: "इंटरफ़ेस थीम", settings: "सेटिंग्स और शॉर्टकट", exit: "बाहर निकलें", unableAi: "AI सेवा बदली नहीं जा सकी" },
  "id-ID": { tagline: "Pencarian seluruh disk dan migrasi AI yang aman", quickWindow: "Pencarian cepat CDriveShiftAI", open: "Buka CDriveShiftAI", quickSearch: "Pencarian cepat", quickFunctions: "Tindakan cepat", overview: "Ringkasan ruang", search: "Pencarian cepat", ownership: "Peta kepemilikan", analyze: "Analisis AI", migrate: "Migrasi aman", history: "Riwayat", aiService: "Layanan AI", enabled: "Aktif", paused: "Dijeda", notTested: "Uji koneksi belum selesai", configureAi: "Atur URL, kunci, dan model…", theme: "Tema antarmuka", settings: "Pengaturan dan pintasan", exit: "Keluar", unableAi: "Tidak dapat mengganti layanan AI" },
  "it-IT": { tagline: "Ricerca su tutti i dischi e migrazione IA sicura", quickWindow: "Ricerca rapida CDriveShiftAI", open: "Apri CDriveShiftAI", quickSearch: "Ricerca rapida", quickFunctions: "Azioni rapide", overview: "Panoramica spazio", search: "Ricerca rapida", ownership: "Mappa proprietà", analyze: "Analisi IA", migrate: "Migrazione sicura", history: "Cronologia", aiService: "Servizio IA", enabled: "Attivo", paused: "In pausa", notTested: "Test di connessione non completato", configureAi: "Configura URL, chiave e modello…", theme: "Tema interfaccia", settings: "Impostazioni e scorciatoie", exit: "Esci", unableAi: "Impossibile cambiare servizio IA" },
  "tr-TR": { tagline: "Tüm disklerde arama ve güvenli yapay zekâ taşıması", quickWindow: "CDriveShiftAI hızlı arama", open: "CDriveShiftAI'ı aç", quickSearch: "Hızlı arama", quickFunctions: "Hızlı işlemler", overview: "Alan özeti", search: "Hızlı arama", ownership: "Sahiplik haritası", analyze: "Yapay zekâ analizi", migrate: "Güvenli taşıma", history: "Taşıma geçmişi", aiService: "Yapay zekâ hizmeti", enabled: "Etkin", paused: "Duraklatıldı", notTested: "Bağlantı testi tamamlanmadı", configureAi: "URL, anahtar ve model ayarla…", theme: "Arayüz teması", settings: "Ayarlar ve kısayollar", exit: "Çıkış", unableAi: "Yapay zekâ hizmeti değiştirilemedi" }
};

export function nativeStrings(language: AppLanguage): NativeStrings {
  return { ...english, ...overrides[resolveNativeLanguage(language)] };
}
