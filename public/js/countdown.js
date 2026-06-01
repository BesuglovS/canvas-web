/**
 * Countdown timer — обратный отсчёт до 27 июня 2026 года (Самарское время, UTC+4)
 * Формат: dd:hh:mm
 */
(function () {
  const TARGET_DATE = new Date("2026-06-27T00:00:00+04:00"); // Самарское время

  const valueEl = document.getElementById("countdown-value");
  const labelEl = document.getElementById("countdown-label");

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function updateCountdown() {
    const now = new Date();
    const diff = TARGET_DATE.getTime() - now.getTime();

    if (diff <= 0) {
      valueEl.textContent = "00:00:00";
      labelEl.textContent = "Выпуск начался! 🎓";
      return;
    }

    const totalMinutes = Math.floor(diff / 60000);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;

    valueEl.textContent = pad(days) + ":" + pad(hours) + ":" + pad(minutes);
    labelEl.textContent = "до выпуска";
  }

  updateCountdown();
  setInterval(updateCountdown, 60000); // обновляем каждую минуту
})();