// Startup. Kept in its own file so it runs after every renderer script has
// been evaluated: bootstrap() reaches render(), which calls renderExecution()
// from renderer-execution.js.


window.addEventListener('focus', () => {
  handleDateBoundary().catch((error) => console.error('Unable to refresh Daymark date:', error));
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) handleDateBoundary().catch((error) => console.error('Unable to refresh Daymark date:', error));
});

bootstrap();
