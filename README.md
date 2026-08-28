# SwingAI DayTrader — Revolut X (AI Agent, Day Trading)
https://tomekfalek-cyber.github.io/swingai-daytrader-revolut/
Agent AI do handlu **intraday** na Revolut X, wykorzystujący koncepcje **Smart Money
Concepts (SMC)**: Order Blocks, Fair Value Gaps, Liquidity Sweep, Break of
Structure / Change of Character, strefy Premium/Discount.

## Status: TYLKO GitHub / GitHub Pages

Ten projekt **na razie nie jest wdrożony na Cloudflare**. Strona działa jako
statyczny podgląd interfejsu, serwowana bezpośrednio z GitHub Pages. Bez
podłączonego Cloudflare Workera funkcje handlowe (Start, zapis konfiguracji,
pobieranie danych rynkowych) nie będą działać — to oczekiwane na tym etapie.

## Ograniczenie Revolut X — brak shortów

Revolut X obsługuje wyłącznie handel spot (Market/Limit buy/sell) — **brak
marginu i lewarowania**. Sygnały "short" wykrywane przez silnik SMC są
**wyłącznie informacyjne** (pokazywane jako strefy na wykresie) — bot nigdy
nie wykonuje rzeczywistej krótkiej sprzedaży, bo giełda na to nie pozwala.

## Architektura

- `worker.js` — silnik Cloudflare Worker (analiza, ryzyko, egzekucja na
  Revolut X). Bazuje na sprawdzonym, wielokrotnie poprawianym silniku
  `swingai-revolut`, dostosowanym do interwałów intraday (1H/15min/5min
  zamiast Daily/4H/1H) i rozszerzonym o warstwę SMC.
- `index.html` / `dashboard/index.html` — interfejs użytkownika.

## Uwaga

To pierwsza wersja tego agenta. Priorytet: brak błędów w kodzie bazowym
(przeniesionym z dzisiejszych poprawek `swingai-bot`/`swingai-revolut`) —
ale nowa warstwa SMC i przeskalowanie na day trading to świeży kod,
nieprzetestowany na realnych danych. Zalecany start: tryb Paper.
