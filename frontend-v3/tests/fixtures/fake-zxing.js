// Replaces js/vendor/zxing.min.js in tests (see mockZxing in helpers.js) so
// scan tests never need real camera hardware / getUserMedia permission.
// Exposes window.__zxingEmit(code, format) once showScanPanel() has started
// a "scan", for a test to call whenever it wants to simulate a decode.
// `format` is one of ZXing.BarcodeFormat's values (defaults to UPC_A) —
// app.js's decode callback always calls result.getBarcodeFormat(), so the
// fake Result object here must support it too, not just getText().
(function () {
  function BrowserMultiFormatReader() {}
  BrowserMultiFormatReader.prototype.decodeFromConstraints = function (constraints, videoEl, callback) {
    window.__zxingEmit = function (code, format) {
      callback({
        getText: function () { return code; },
        getBarcodeFormat: function () { return format || window.ZXing.BarcodeFormat.UPC_A; }
      }, null);
    };
    return Promise.resolve();
  };
  BrowserMultiFormatReader.prototype.reset = function () {
    delete window.__zxingEmit;
  };

  function NotFoundException() {}

  window.ZXing = {
    BrowserMultiFormatReader: BrowserMultiFormatReader,
    DecodeHintType: { POSSIBLE_FORMATS: 'POSSIBLE_FORMATS' },
    BarcodeFormat: { UPC_A: 'UPC_A', UPC_E: 'UPC_E', EAN_13: 'EAN_13', EAN_8: 'EAN_8' },
    NotFoundException: NotFoundException
  };
})();
