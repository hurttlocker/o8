export const O8_WEBVIEW_ASYNC_EVAL_GUARD = String.raw`
  // The execute_js transport takes this function's SYNCHRONOUS completion
  // value, so a Promise cannot be awaited here. A pending Promise also has no
  // own enumerable keys, so it serialized to {} and sailed through every
  // serializability probe below as ok:true -- the caller was told the eval
  // succeeded and handed an empty object (#1735). Say what actually happened
  // instead, and name the pattern that does work.
  let __o8_then__;
  try {
    __o8_then__ = __o8_value__ && __o8_value__.then;
  } catch (__o8_then_err__) {
    return JSON.stringify({
      ok: false,
      error: {
        name: 'AsyncEvalUnsupported',
        message: 'The expression returned a malformed async result whose then property could not be inspected: ' + ((__o8_then_err__ && __o8_then_err__.message) || String(__o8_then_err__)),
        stack: null,
      },
    });
  }
  if (typeof __o8_then__ === 'function') {
    try {
      // Attach both outcomes before returning so an already-rejected Promise
      // does not become an unhandled rejection in the webview.
      __o8_then__.call(__o8_value__, function () {}, function () {});
    } catch (__o8_then_err__) {
      return JSON.stringify({
        ok: false,
        error: {
          name: 'AsyncEvalUnsupported',
          message: 'The expression returned a malformed async result whose then function could not be observed safely: ' + ((__o8_then_err__ && __o8_then_err__.message) || String(__o8_then_err__)),
          stack: null,
        },
      });
    }
    return JSON.stringify({
      ok: false,
      error: {
        name: 'AsyncEvalUnsupported',
        message: 'The expression returned a Promise, and this eval bridge reads a synchronous completion value, so the resolved value cannot be returned. Start the async work with Promise.resolve(...).then(function (value) { window.__myKey = value; }), then read window.__myKey with a second, synchronous eval.',
        stack: null,
      },
    });
  }
`;
