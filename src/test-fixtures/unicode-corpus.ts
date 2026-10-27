/**
 * Shared Unicode test corpus for outbound chunking (openclaw-meshtastic and
 * openclaw-meshcore keep identical copies). Realistic short texts; tests repeat
 * them to force several chunks. `spaces: false` entries exercise the hard-split
 * path, `combining: true` entries contain multi-code-point graphemes.
 */
export type CorpusEntry = { text: string; spaces: boolean; combining: boolean };

export const UNICODE_CORPUS: Record<string, CorpusEntry> = {
  german: { text: "Grüße aus Weinitzen! Über Österreichs Hügel weht Föhn, die Straße nach Graz ist frei.", spaces: true, combining: false },
  french: { text: "Voix ambiguë d'un cœur qui, au zéphyr, préfère les jattes de kiwis.", spaces: true, combining: false },
  polish: { text: "Zażółć gęślą jaźń. Pchnąć w tę łódź jeża lub ośm skrzyń fig.", spaces: true, combining: false },
  czech: { text: "Příliš žluťoučký kůň úpěl ďábelské ódy.", spaces: true, combining: false },
  hungarian: { text: "Árvíztűrő tükörfúrógép. Öt szép szűzlány őrült írót nyúz.", spaces: true, combining: false },
  greek: { text: "Γεια σας! Αυτό είναι ένα δοκιμαστικό μήνυμα για τον έλεγχο.", spaces: true, combining: false },
  russian: { text: "Привет! Это тестовое сообщение для проверки разбиения длинных ответов.", spaces: true, combining: false },
  chineseSimplified: { text: "你好！这是一条用于测试长回复分段的消息，中文没有空格，所以只能按字符切分。", spaces: false, combining: false },
  chineseTraditional: { text: "你好！這是一條用於測試長回覆分段的訊息，中文沒有空格，所以只能按字元切分。", spaces: false, combining: false },
  hebrew: { text: "שלום! זוהי הודעת בדיקה לפיצול תשובות ארוכות לכמה חלקים.", spaces: true, combining: false },
  hebrewNiqqud: { text: "שָׁלוֹםעֲלֵיכֶםבְּרוּכִיםהַבָּאִים", spaces: false, combining: true },
  arabic: { text: "مرحبا! هذه رسالة اختبار لتقسيم الردود الطويلة إلى عدة أجزاء.", spaces: true, combining: false },
  arabicTashkeel: { text: "مَرْحَبًابِكُمْفِيالشَّبَكَةِ", spaces: false, combining: true },
  thai: { text: "สวัสดีครับนี่คือข้อความทดสอบภาษาไทย", spaces: false, combining: true },
  hindi: { text: "क्षत्रियोंकीजाँचकेलिएसंदेश", spaces: false, combining: true },
  emojiSequences: { text: "👨‍👩‍👧‍👦🇦🇹👍🏽🏳️‍🌈", spaces: false, combining: true },
  // Written with escapes on purpose: an editor normalizing to NFC would otherwise silently "fix" it.
  decomposedUmlaut: { text: "Mu\u0308llerGru\u0308\u00dfeU\u0308bero\u0308sterreichFo\u0308hn", spaces: false, combining: true },
};

