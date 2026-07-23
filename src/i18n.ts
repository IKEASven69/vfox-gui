import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import zh from "./locales/zh.json";
import en from "./locales/en.json";

const saved = localStorage.getItem("vfox-lang") || "zh";

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: { zh: { translation: zh }, en: { translation: en } },
    lng: saved,
    fallbackLng: "zh",
    interpolation: { escapeValue: false },
    detection: {
      order: ["localStorage", "navigator"],
      caches: ["localStorage"],
      lookupLocalStorage: "vfox-lang",
    },
  });

export default i18n;
