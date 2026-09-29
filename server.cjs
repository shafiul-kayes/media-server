// Entry point for hosts that load the app with require() (Hostinger, Passenger, LiteSpeed).
// The app itself is an ES module with top-level await, which require() cannot load directly,
// so it is started with a dynamic import instead.
import('./src/server.js').catch((err) => {
  console.error(err);
  process.exit(1);
});
