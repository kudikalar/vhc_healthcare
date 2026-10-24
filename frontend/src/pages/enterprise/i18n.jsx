// Language and accessibility preferences (§38).
//
// useT() returns t(englishString): dictionaries are keyed by the English text, so untranslated strings
// simply fall back to English. Legally binding text (policy wording, regulatory disclosures, terms) is
// deliberately left in English — pages show LEGAL_NOTE when another language is selected.
// More languages can be added by appending to LANGUAGES and DICTIONARIES.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

export const LANGUAGES = [
  { code: 'en', label: 'English', short: 'EN' },
  { code: 'hi', label: 'हिन्दी', short: 'हिं', english: 'Hindi' },
  { code: 'te', label: 'తెలుగు', short: 'తె', english: 'Telugu' },
];

// [English, Hindi, Telugu]
const ROWS = [
  // ---- shell / sidebar (components/Layout.jsx NAV) ----
  ['Home', 'होम', 'హోమ్'],
  ['Explore cover', 'कवर देखें', 'కవర్ చూడండి'],
  ['My family', 'मेरा परिवार', 'నా కుటుంబం'],
  ['My policies', 'मेरी पॉलिसियाँ', 'నా పాలసీలు'],
  ['Claims', 'क्लेम', 'క్లెయిమ్‌లు'],
  ['Hospitals', 'अस्पताल', 'ఆసుపత్రులు'],
  ['Payments', 'भुगतान', 'చెల్లింపులు'],
  ['Documents', 'दस्तावेज़', 'పత్రాలు'],
  ['Support', 'सहायता', 'సహాయం'],
  ['AI tools', 'एआई टूल', 'ఏఐ సాధనాలు'],
  ['Vision AI', 'विज़न एआई', 'విజన్ ఏఐ'],
  ['Claim estimator', 'क्लेम अनुमान', 'క్లెయిమ్ అంచనా'],
  ['Cover planner', 'कवर प्लानर', 'కవర్ ప్లానర్'],
  ['Buying cover', 'कवर खरीदना', 'కవర్ కొనుగోలు'],
  ['Get a quote', 'कोटेशन पाएँ', 'కోట్ పొందండి'],
  ['Applications', 'आवेदन', 'దరఖాస్తులు'],
  ['Account', 'खाता', 'ఖాతా'],
  ['Notifications', 'सूचनाएँ', 'నోటిఫికేషన్లు'],
  ['Profile & security', 'प्रोफ़ाइल और सुरक्षा', 'ప్రొఫైల్ & భద్రత'],
  ['Workspace', 'कार्यक्षेत्र', 'వర్క్‌స్పేస్'],
  ['My work', 'मेरा काम', 'నా పని'],
  ['Insights', 'विश्लेषण', 'విశ్లేషణలు'],
  ['Reference', 'संदर्भ', 'సూచన'],
  ['Plan catalogue', 'प्लान सूची', 'ప్లాన్ జాబితా'],
  ['My profile', 'मेरी प्रोफ़ाइल', 'నా ప్రొఫైల్'],
  ['Underwriting', 'अंडरराइटिंग', 'అండర్‌రైటింగ్'],
  ['Servicing', 'सर्विसिंग', 'సర్వీసింగ్'],
  ['Health claims', 'स्वास्थ्य क्लेम', 'ఆరోగ్య క్లెయిమ్‌లు'],
  ['Life claims', 'जीवन क्लेम', 'జీవిత క్లెయిమ్‌లు'],
  ['Payments & payouts', 'भुगतान और पेआउट', 'చెల్లింపులు & చెల్లింపు విడుదల'],
  ['Financial exceptions', 'वित्तीय अपवाद', 'ఆర్థిక మినహాయింపులు'],
  ['Applications & underwriting', 'आवेदन और अंडरराइटिंग', 'దరఖాస్తులు & అండర్‌రైటింగ్'],
  ['Reports & audit', 'रिपोर्ट और ऑडिट', 'నివేదికలు & ఆడిట్'],
  ['Administration', 'प्रशासन', 'నిర్వహణ'],
  ['Plans & rates', 'प्लान और दरें', 'ప్లాన్‌లు & రేట్లు'],
  ['Users & roles', 'उपयोगकर्ता और भूमिकाएँ', 'వినియోగదారులు & పాత్రలు'],
  ['Dev tools', 'डेवलपर टूल', 'డెవలపర్ సాధనాలు'],
  ['Policies', 'पॉलिसियाँ', 'పాలసీలు'],
  ['Help', 'मदद', 'సహాయం'],
  ['More', 'और', 'మరిన్ని'],
  ['Menu', 'मेनू', 'మెనూ'],
  ['Plans', 'प्लान', 'ప్లాన్‌లు'],
  ['Report a life claim', 'जीवन क्लेम दर्ज करें', 'జీవిత క్లెయిమ్ నివేదించండి'],
  ['Sign in', 'साइन इन', 'సైన్ ఇన్'],
  ['Create account', 'खाता बनाएँ', 'ఖాతా సృష్టించండి'],
  ['Claim help', 'क्लेम सहायता', 'క్లెయిమ్ సహాయం'],
  ['Skip to main content', 'मुख्य सामग्री पर जाएँ', 'ప్రధాన కంటెంట్‌కు వెళ్ళండి'],
  ['Need help with a claim?', 'क्लेम में मदद चाहिए?', 'క్లెయిమ్‌లో సహాయం కావాలా?'],
  ['Get claim help →', 'क्लेम सहायता पाएँ →', 'క్లెయిమ్ సహాయం పొందండి →'],
  // ---- module labels (all platform modules) ----
  ['Insurer portal', 'बीमाकर्ता पोर्टल', 'బీమా సంస్థ పోర్టల్'],
  ['Partners', 'साझेदार', 'భాగస్వాములు'],
  ['Insurers', 'बीमाकर्ता', 'బీమా సంస్థలు'],
  ['Integration hub', 'इंटीग्रेशन हब', 'ఇంటిగ్రేషన్ హబ్'],
  ['Sales', 'बिक्री', 'అమ్మకాలు'],
  ['Leads & pipeline', 'लीड और पाइपलाइन', 'లీడ్‌లు & పైప్‌లైన్'],
  ['Hospital portal', 'अस्पताल पोर्टल', 'ఆసుపత్రి పోర్టల్'],
  ['TPA portal', 'टीपीए पोर्टल', 'టీపీఏ పోర్టల్'],
  ['Network', 'नेटवर्क', 'నెట్‌వర్క్'],
  ['Providers', 'सेवा प्रदाता', 'సేవా ప్రదాతలు'],
  ['Contracts', 'अनुबंध', 'ఒప్పందాలు'],
  ['Cashless networks', 'कैशलेस नेटवर्क', 'క్యాష్‌లెస్ నెట్‌వర్క్‌లు'],
  ['TPAs', 'टीपीए', 'టీపీఏలు'],
  ['Bookings', 'बुकिंग', 'బుకింగ్‌లు'],
  ['Health services', 'स्वास्थ्य सेवाएँ', 'ఆరోగ్య సేవలు'],
  ['Appointments', 'अपॉइंटमेंट', 'అపాయింట్‌మెంట్లు'],
  ['Grievances', 'शिकायतें', 'ఫిర్యాదులు'],
  ['Claims operations', 'क्लेम संचालन', 'క్లెయిమ్ కార్యకలాపాలు'],
  ['Claims SLA board', 'क्लेम एसएलए बोर्ड', 'క్లెయిమ్ ఎస్ఎల్ఏ బోర్డు'],
  ['Fraud review', 'धोखाधड़ी समीक्षा', 'మోసం సమీక్ష'],
  ['Intimations', 'सूचनाएँ (इंटिमेशन)', 'సమాచారాలు'],
  ['Employer portal', 'नियोक्ता पोर्टल', 'యజమాని పోర్టల్'],
  ['Employees', 'कर्मचारी', 'ఉద్యోగులు'],
  ['Group policies', 'समूह पॉलिसियाँ', 'గ్రూప్ పాలసీలు'],
  ['Endorsements', 'पृष्ठांकन', 'ఎండార్స్‌మెంట్లు'],
  ['Invoices', 'चालान', 'ఇన్‌వాయిస్‌లు'],
  ['Wellness', 'वेलनेस', 'వెల్‌నెస్'],
  ['Corporate', 'कॉर्पोरेट', 'కార్పొరేట్'],
  ['Employers', 'नियोक्ता', 'యజమానులు'],
  ['Employee benefits', 'कर्मचारी लाभ', 'ఉద్యోగి ప్రయోజనాలు'],
  ['Command centre', 'कमांड सेंटर', 'కమాండ్ సెంటర్'],
  ['Finance', 'वित्त', 'ఆర్థికం'],
  ['Helpdesk', 'हेल्पडेस्क', 'హెల్ప్‌డెస్క్'],
  ['Support tickets', 'सहायता टिकट', 'సపోర్ట్ టికెట్లు'],
  ['Compliance', 'अनुपालन', 'నిబంధనల పాటింపు'],
  ['Audit log', 'ऑडिट लॉग', 'ఆడిట్ లాగ్'],
  ['Data requests', 'डेटा अनुरोध', 'డేటా అభ్యర్థనలు'],
  ['Enterprise', 'एंटरप्राइज़', 'ఎంటర్‌ప్రైజ్'],
  ['Payment scenarios', 'भुगतान परिदृश्य', 'చెల్లింపు సన్నివేశాలు'],
  ['Refunds', 'रिफ़ंड', 'రీఫండ్‌లు'],
  ['Reconciliation', 'मिलान', 'సరిపోల్చడం'],
  ['Knowledge base', 'जानकारी केंद्र', 'సమాచార కేంద్రం'],
  ['Oversight', 'निगरानी', 'పర్యవేక్షణ'],
  ['Consent register', 'सहमति रजिस्टर', 'సమ్మతి రిజిస్టర్'],
  ['Command', 'कमांड', 'కమాండ్'],
  ['Finance (read-only)', 'वित्त (केवल पढ़ें)', 'ఆర్థికం (చదవడానికి మాత్రమే)'],
  // ---- controls ----
  ['Language', 'भाषा', 'భాష'],
  ['Larger text', 'बड़ा टेक्स्ट', 'పెద్ద అక్షరాలు'],
  ['Legal and regulatory text is shown in English; translations are for convenience only.', 'कानूनी और नियामक पाठ अंग्रेज़ी में दिखाया गया है; अनुवाद केवल सुविधा के लिए है।', 'చట్టపరమైన మరియు నియంత్రణ పాఠ్యం ఇంగ్లీష్‌లో చూపబడుతుంది; అనువాదాలు సౌలభ్యం కోసం మాత్రమే.'],
  // ---- landing ----
  ['Health insurance', 'स्वास्थ्य बीमा', 'ఆరోగ్య బీమా'],
  ['Compare', 'तुलना करें', 'పోల్చండి'],
  ['Partner hospitals', 'साझेदार अस्पताल', 'భాగస్వామి ఆసుపత్రులు'],
  ['Claims assistance', 'क्लेम सहायता', 'క్లెయిమ్ సహాయం'],
  ['Corporate insurance', 'कॉर्पोरेट बीमा', 'కార్పొరేట్ బీమా'],
  ['About VHC', 'VHC के बारे में', 'VHC గురించి'],
  ['Contact & support', 'संपर्क और सहायता', 'సంప్రదింపు & సహాయం'],
  ['Sandbox · no live insurance sales', 'सैंडबॉक्स · कोई वास्तविक बीमा बिक्री नहीं', 'శాండ్‌బాక్స్ · నిజమైన బీమా అమ్మకాలు లేవు'],
  ['Health insurance, explained honestly.', 'स्वास्थ्य बीमा, ईमानदारी से समझाया गया।', 'ఆరోగ్య బీమా, నిజాయితీగా వివరించబడింది.'],
  ['Compare plans from licensed insurers side by side, see exclusions and waiting periods before you buy, and get help with cashless treatment and claims.', 'लाइसेंस प्राप्त बीमाकर्ताओं के प्लान की साथ-साथ तुलना करें, खरीदने से पहले अपवाद और प्रतीक्षा अवधि देखें, और कैशलेस इलाज व क्लेम में मदद पाएँ।', 'లైసెన్స్ పొందిన బీమా సంస్థల ప్లాన్‌లను పక్కపక్కనే పోల్చండి, కొనేముందు మినహాయింపులు, వెయిటింగ్ పీరియడ్‌లు చూడండి, క్యాష్‌లెస్ చికిత్స మరియు క్లెయిమ్‌లలో సహాయం పొందండి.'],
  ['Find health insurance', 'स्वास्थ्य बीमा खोजें', 'ఆరోగ్య బీమా కనుగొనండి'],
  ['Compare plans', 'प्लान की तुलना करें', 'ప్లాన్‌లను పోల్చండి'],
  ['Find a hospital', 'अस्पताल खोजें', 'ఆసుపత్రిని కనుగొనండి'],
  ['Request a callback', 'कॉलबैक का अनुरोध करें', 'కాల్‌బ్యాక్ అభ్యర్థించండి'],
  ['No commission-based ranking', 'कमीशन के आधार पर कोई रैंकिंग नहीं', 'కమీషన్ ఆధారిత ర్యాంకింగ్ లేదు'],
  ['Exclusions shown first', 'अपवाद पहले दिखाए जाते हैं', 'మినహాయింపులు ముందుగా చూపబడతాయి'],
  ['Insurer named on every product', 'हर उत्पाद पर बीमाकर्ता का नाम', 'ప్రతి ఉత్పత్తిపై బీమా సంస్థ పేరు'],
  ['Quick premium estimate', 'त्वरित प्रीमियम अनुमान', 'త్వరిత ప్రీమియం అంచనా'],
  ['Age of eldest member', 'सबसे बड़े सदस्य की आयु', 'పెద్ద సభ్యుని వయస్సు'],
  ['Members', 'सदस्य', 'సభ్యులు'],
  ['City', 'शहर', 'నగరం'],
  ['Sum insured', 'बीमा राशि', 'బీమా మొత్తం'],
  ['See my estimate', 'मेरा अनुमान देखें', 'నా అంచనా చూడండి'],
  ['Estimates are calculated by the insurer\'s rating rules on the next page. No personal data is stored.', 'अनुमान अगले पृष्ठ पर बीमाकर्ता के नियमों से गणना होता है। कोई व्यक्तिगत डेटा संग्रहीत नहीं होता।', 'అంచనా తదుపరి పేజీలో బీమా సంస్థ నియమాల ప్రకారం లెక్కించబడుతుంది. వ్యక్తిగత డేటా నిల్వ చేయబడదు.'],
  ['Health insurance categories', 'स्वास्थ्य बीमा श्रेणियाँ', 'ఆరోగ్య బీమా వర్గాలు'],
  ['Individual', 'व्यक्तिगत', 'వ్యక్తిగత'],
  ['Family floater', 'फ़ैमिली फ़्लोटर', 'ఫ్యామిలీ ఫ్లోటర్'],
  ['Senior citizen', 'वरिष्ठ नागरिक', 'సీనియర్ సిటిజన్'],
  ['Top-up', 'टॉप-अप', 'టాప్-అప్'],
  ['Super top-up', 'सुपर टॉप-अप', 'సూపర్ టాప్-అప్'],
  ['Critical illness', 'गंभीर बीमारी', 'తీవ్ర అనారోగ్యం'],
  ['Personal accident', 'व्यक्तिगत दुर्घटना', 'వ్యక్తిగత ప్రమాదం'],
  ['Group medical', 'समूह चिकित्सा', 'గ్రూప్ మెడికల్'],
  ['Insurer catalogue', 'बीमाकर्ता सूची', 'బీమా సంస్థల జాబితా'],
  ['Why VHC', 'VHC क्यों', 'VHC ఎందుకు'],
  ['How buying works', 'खरीदारी कैसे होती है', 'కొనుగోలు ఎలా జరుగుతుంది'],
  ['Cashless hospital search', 'कैशलेस अस्पताल खोज', 'క్యాష్‌లెస్ ఆసుపత్రి శోధన'],
  ['Search hospitals', 'अस्पताल खोजें', 'ఆసుపత్రులను శోధించండి'],
  ['Specialty', 'विशेषता', 'ప్రత్యేకత'],
  ['How we help with claims', 'क्लेम में हम कैसे मदद करते हैं', 'క్లెయిమ్‌లలో మేము ఎలా సహాయం చేస్తాము'],
  ['Learn about health insurance', 'स्वास्थ्य बीमा के बारे में जानें', 'ఆరోగ్య బీమా గురించి తెలుసుకోండి'],
  ['Frequently asked questions', 'अक्सर पूछे जाने वाले प्रश्न', 'తరచుగా అడిగే ప్రశ్నలు'],
  ['Regulatory disclosures', 'नियामक प्रकटीकरण', 'నియంత్రణ వెల్లడింపులు'],
  ['Name', 'नाम', 'పేరు'],
  ['Mobile number', 'मोबाइल नंबर', 'మొబైల్ నంబర్'],
  ['Email (optional)', 'ईमेल (वैकल्पिक)', 'ఈమెయిల్ (ఐచ్ఛికం)'],
  ['I am interested in', 'मेरी रुचि है', 'నాకు ఆసక్తి ఉంది'],
  ['Request callback', 'कॉलबैक माँगें', 'కాల్‌బ్యాక్ అభ్యర్థించండి'],
  ['Health services booking', 'स्वास्थ्य सेवाओं की बुकिंग', 'ఆరోగ్య సేవల బుకింగ్'],
  ['For employers', 'नियोक्ताओं के लिए', 'యజమానుల కోసం'],
  // ---- support ----
  ['Claim help, answers to common questions and how to reach us.', 'क्लेम सहायता, सामान्य प्रश्नों के उत्तर और हमसे संपर्क कैसे करें।', 'క్లెయిమ్ సహాయం, సాధారణ ప్రశ్నలకు సమాధానాలు మరియు మమ్మల్ని ఎలా సంప్రదించాలి.'],
  ['In a medical emergency, get care first.', 'चिकित्सा आपातकाल में पहले इलाज कराएँ।', 'వైద్య అత్యవసర పరిస్థితిలో ముందుగా చికిత్స పొందండి.'],
  ['Common questions', 'सामान्य प्रश्न', 'సాధారణ ప్రశ్నలు'],
  ['Contact us', 'संपर्क करें', 'మమ్మల్ని సంప్రదించండి'],
  ['Raise a support ticket', 'सहायता टिकट बनाएँ', 'సపోర్ట్ టికెట్ నమోదు చేయండి'],
  ['My tickets', 'मेरे टिकट', 'నా టికెట్లు'],
  ['Which route is right for you?', 'आपके लिए कौन सा रास्ता सही है?', 'మీకు ఏ మార్గం సరైనది?'],
  ['Support ticket', 'सहायता टिकट', 'సపోర్ట్ టికెట్'],
  ['Formal grievance', 'औपचारिक शिकायत', 'అధికారిక ఫిర్యాదు'],
  ['Complaint to the insurer or IRDAI', 'बीमाकर्ता या IRDAI से शिकायत', 'బీమా సంస్థ లేదా IRDAIకి ఫిర్యాదు'],
  ['How a health claim works', 'स्वास्थ्य क्लेम कैसे काम करता है', 'ఆరోగ్య క్లెయిమ్ ఎలా పనిచేస్తుంది'],
  ['Documents to keep ready', 'तैयार रखने के दस्तावेज़', 'సిద్ధంగా ఉంచాల్సిన పత్రాలు'],
  ['Planned hospital stay', 'नियोजित अस्पताल प्रवास', 'ముందుగా నిర్ణయించిన ఆసుపత్రి బస'],
  ['Already paid the hospital', 'अस्पताल को भुगतान कर चुके हैं', 'ఆసుపత్రికి ఇప్పటికే చెల్లించారు'],
  ['Report a death claim', 'मृत्यु क्लेम दर्ज करें', 'మరణ క్లెయిమ్ నివేదించండి'],
  ['Track an existing claim', 'मौजूदा क्लेम ट्रैक करें', 'ఉన్న క్లెయిమ్‌ను ట్రాక్ చేయండి'],
  ['New ticket', 'नया टिकट', 'కొత్త టికెట్'],
  ['Subject', 'विषय', 'విషయం'],
  ['Category', 'श्रेणी', 'వర్గం'],
  ['Describe the issue', 'समस्या बताइए', 'సమస్యను వివరించండి'],
  ['Send', 'भेजें', 'పంపండి'],
  ['Status', 'स्थिति', 'స్థితి'],
];

const DICTIONARIES = {
  hi: Object.fromEntries(ROWS.map(([en, hi]) => [en, hi])),
  te: Object.fromEntries(ROWS.map(([en, , te]) => [en, te])),
};
export const LEGAL_NOTE = 'Legal and regulatory text is shown in English; translations are for convenience only.';

const read = (k, d) => { try { return window.localStorage.getItem(k) ?? d; } catch { return d; } };
const write = (k, v) => { try { window.localStorage.setItem(k, v); } catch { /* storage unavailable (private mode) */ } };

// Module-level mirror so non-React code (e.g. the nav proxy in index.jsx) can translate too.
let current = 'en';
export const translate = (s, lang = current) => (lang !== 'en' && DICTIONARIES[lang]?.[s]) || s;

const LangCtx = createContext({ lang: 'en', setLang: () => {}, largeText: false, setLargeText: () => {}, t: (s) => s });

export function LanguageProvider({ children }) {
  const [lang, setLangState] = useState(() => { const l = read('vhc.lang', 'en'); return LANGUAGES.some((x) => x.code === l) ? l : 'en'; });
  const [largeText, setLargeState] = useState(() => read('vhc.largeText', '0') === '1');
  current = lang;
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.classList.toggle('vhc-lang-indic', lang !== 'en');
  }, [lang]);
  useEffect(() => { document.documentElement.classList.toggle('vhc-large-text', largeText); }, [largeText]);
  const setLang = useCallback((l) => { if (LANGUAGES.some((x) => x.code === l)) { write('vhc.lang', l); current = l; setLangState(l); } }, []);
  const setLargeText = useCallback((v) => { write('vhc.largeText', v ? '1' : '0'); setLargeState(!!v); }, []);
  const value = useMemo(() => ({ lang, setLang, largeText, setLargeText, t: (s) => translate(s, lang) }), [lang, largeText, setLang, setLargeText]);
  return <LangCtx.Provider value={value}>{children}</LangCtx.Provider>;
}

/** t(englishString) → the string in the selected language (English fallback). */
export const useT = () => useContext(LangCtx).t;
export const useLang = () => useContext(LangCtx);

/** Compact language selector + "A+" larger-text toggle for the top bar. */
export function LanguageControls() {
  const { lang, setLang, largeText, setLargeText, t } = useLang();
  return (
    <div className="ent-lang" role="group" aria-label={t('Language')}>
      <label className="sr-only" htmlFor="vhc-lang">{t('Language')}</label>
      <select id="vhc-lang" value={lang} onChange={(e) => setLang(e.target.value)} title={t('Language')}>
        {LANGUAGES.map((l) => <option key={l.code} value={l.code} lang={l.code}>{l.short} · {l.label}</option>)}
      </select>
      <button type="button" className={`ent-aplus ${largeText ? 'on' : ''}`} aria-pressed={largeText} onClick={() => setLargeText(!largeText)} title={t('Larger text')} aria-label={t('Larger text')}>A+</button>
    </div>
  );
}

/** Shown wherever translated pages also carry legally binding English text. */
export function LegalNote() {
  const { lang, t } = useLang();
  if (lang === 'en') return null;
  return <p className="ent-legal-note" role="note">{t(LEGAL_NOTE)}</p>;
}
