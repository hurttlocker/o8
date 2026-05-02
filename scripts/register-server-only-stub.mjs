import Module from 'node:module';

const originalLoad = Module._load;

Module._load = function loadWithServerOnlyStub(request, parent, isMain) {
  if (request === 'server-only') {
    return {};
  }
  return originalLoad.call(this, request, parent, isMain);
};
