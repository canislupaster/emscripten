/**
 * @license
 * Copyright 2023 The Emscripten Authors
 * SPDX-License-Identifier: MIT
 */

#if WASM_WORKERS

#if !SHARED_MEMORY
#error "Internal error! SHARED_MEMORY should be enabled when building with WASM_WORKERS"
#endif
#if SINGLE_FILE
#error "-sSINGLE_FILE is not supported with -sWASM_WORKERS"
#endif
#if LINKABLE
#error "-sLINKABLE is not supported with -sWASM_WORKERS"
#endif
#if RELOCATABLE
#error "dynamic linking is not supported with -sWASM_WORKERS"
#endif
#if PROXY_TO_WORKER
#error "-sPROXY_TO_WORKER is not supported with -sWASM_WORKERS"
#endif
#if WASM2JS && MODULARIZE
#error "-sWASM=0 + -sMODULARIZE + -sWASM_WORKERS is not supported"
#endif

{{{
  const workerSupportsFutexWait = () => AUDIO_WORKLET ? "typeof AudioWorkletGlobalScope === 'undefined'" : '1';
  const wasmWorkerJs = `
#if MINIMAL_RUNTIME
#if ENVIRONMENT_MAY_BE_NODE
    Module['js'] || './${TARGET_JS_NAME}'
#else
    Module['js']
#endif
#else
    locateFile('${TARGET_JS_NAME}')
#endif
`;
  const wasmWorkerOptions = `{
#if ENVIRONMENT_MAY_BE_NODE
  // This is the way that we signal to the node worker that it is hosting
  // a wasm worker.
  'workerData': 'em-ww',
#endif
#if ENVIRONMENT_MAY_BE_WEB || ENVIRONMENT_MAY_BE_WORKER
  // This is the way that we signal to the Web Worker that it is hosting
  // a pthread.
  'name': 'em-ww',
#endif
}`;
}}}

#endif // ~WASM_WORKERS


addToLibrary({
  $_wasmWorkers: {},
  $_wasmWorkersID: 1,

  // Starting up a Wasm Worker is an asynchronous operation, hence if the parent
  // thread performs any postMessage()-based wasm function calls s to the
  // Worker, they must be delayed until the async startup has finished, after
  // which these postponed function calls can be dispatched.
  $_wasmWorkerDelayedMessageQueue: [],

  $_wasmWorkerAppendToQueue: (e) => {
    _wasmWorkerDelayedMessageQueue.push(e);
  },

  // Executes a wasm function call received via a postMessage.
  $_wasmWorkerRunPostMessage__deps: ['$callUserCallback'],
  $_wasmWorkerRunPostMessage: (e) => {
    // '_wsc' is short for 'wasm call', trying to use an identifier name that
    // will never conflict with user code
    let data = e.data;
    let wasmCall = data['_wsc'];
    wasmCall && callUserCallback(() => getWasmTableEntry(wasmCall)(...data['x']));
  },

  // src/postamble_minimal.js brings this symbol in to the build, and calls this
  // function synchronously from main JS file at the startup of each Worker.
  $_wasmWorkerInitializeRuntime__deps: [
    '$_wasmWorkerDelayedMessageQueue',
    '$_wasmWorkerRunPostMessage',
    '$_wasmWorkerAppendToQueue',
    '_emscripten_wasm_worker_initialize',
#if PTHREADS
    '__set_thread_state',
#endif
  ],
  $_wasmWorkerInitializeRuntime: () => {
    let m = Module;
#if ASSERTIONS
    assert(m && m['$ww']);
    assert(m['sb'] % 16 == 0);
    assert(m['sz'] % 16 == 0);
#endif
#if RUNTIME_DEBUG
    dbg("wasmWorkerInitializeRuntime $ww:", m['$ww']);
#endif

#if !MINIMAL_RUNTIME && isSymbolNeeded('$noExitRuntime')
    // Wasm workers basically never exit their runtime
    noExitRuntime = 1;
#endif

#if STACK_OVERFLOW_CHECK >= 2
    // _emscripten_wasm_worker_initialize() initializes the stack for this
    // Worker, but it cannot call to extern __set_stack_limits() function, or
    // Binaryen breaks with "Fatal: Module::addFunction: __set_stack_limits
    // already exists".  So for now, invoke this function from JS side. TODO:
    // remove this in the future.  Note that this call is not exactly correct,
    // since this limit will include the TLS slot, that will be part of the
    // region between m['sb'] and m['sz'], so we need to fix up the call below.
    ___set_stack_limits(m['sb'] + m['sz'], m['sb']);
#endif
    // Run the C side Worker initialization for stack and TLS.
    __emscripten_wasm_worker_initialize(m['sb'], m['sz']);
#if PTHREADS
    // Record the pthread configuration, and whether this Wasm Worker supports synchronous blocking in emscripten_futex_wait().
    // (regular Wasm Workers do, AudioWorklets don't)
    ___set_thread_state(/*thread_ptr=*/0, /*is_main_thread=*/0, /*is_runtime_thread=*/0, /*supports_wait=*/ {{{ workerSupportsFutexWait() }}});
#endif
#if STACK_OVERFLOW_CHECK >= 2
    // Fix up stack base. (TLS frame is created at the bottom address end of the stack)
    // See https://github.com/emscripten-core/emscripten/issues/16496
    ___set_stack_limits(_emscripten_stack_get_base(), _emscripten_stack_get_end());
#endif

#if STACK_OVERFLOW_CHECK
    // Write the stack cookie last, after we have set up the proper bounds and
    // current position of the stack.
    writeStackCookie();
#endif

#if AUDIO_WORKLET
    // Audio Worklets do not have postMessage()ing capabilities.
    if (typeof AudioWorkletGlobalScope === 'undefined') {
#endif
      // The Wasm Worker runtime is now up, so we can start processing
      // any postMessage function calls that have been received. Drop the temp
      // message handler that queued any pending incoming postMessage function calls ...
      removeEventListener('message', _wasmWorkerAppendToQueue);
      // ... then flush whatever messages we may have already gotten in the queue,
      //     and clear _wasmWorkerDelayedMessageQueue to undefined ...
      _wasmWorkerDelayedMessageQueue = _wasmWorkerDelayedMessageQueue.forEach(_wasmWorkerRunPostMessage);
      // ... and finally register the proper postMessage handler that immediately
      // dispatches incoming function calls without queueing them.
      addEventListener('message', _wasmWorkerRunPostMessage);
#if AUDIO_WORKLET
    }
#endif
  },

  _emscripten_create_wasm_worker__deps: [
    '$_wasmWorkers', '$_wasmWorkersID',
    '$_wasmWorkerAppendToQueue', '$_wasmWorkerRunPostMessage',
#if ASSERTIONS
    'emscripten_has_threading_support',
#endif
  ],
  _emscripten_create_wasm_worker__postset: `
if (ENVIRONMENT_IS_WASM_WORKER
// AudioWorkletGlobalScope does not contain addEventListener
#if AUDIO_WORKLET
  && !ENVIRONMENT_IS_AUDIO_WORKLET
#endif
  ) {
  _wasmWorkers[0] = globalThis;
  addEventListener("message", _wasmWorkerAppendToQueue);
}`,
  _emscripten_create_wasm_worker: (stackLowestAddress, stackSize) => {
#if ASSERTIONS
    if (!_emscripten_has_threading_support()) {
      err('create_wasm_worker: environment does not support SharedArrayBuffer, wasm workers are not available');
      return 0;
    }
#endif
    let worker;
#if TRUSTED_TYPES
    // Use Trusted Types compatible wrappers.
    if (typeof trustedTypes != 'undefined' && trustedTypes.createPolicy) {
      var p = trustedTypes.createPolicy(
          'emscripten#workerPolicy1', { createScriptURL: (ignored) => {{{ wasmWorkerJs }}}}
      );
      worker = _wasmWorkers[_wasmWorkersID] = new Worker(p.createScriptURL('ignored'), {{{ wasmWorkerOptions }}});
    } else
#endif
    worker = _wasmWorkers[_wasmWorkersID] = new Worker({{{ wasmWorkerJs }}}, {{{ wasmWorkerOptions }}});
    // Craft the Module object for the Wasm Worker scope:
    worker.postMessage({
      // Signal with a non-zero value that this Worker will be a Wasm Worker,
      // and not the main browser thread.
      '$ww': _wasmWorkersID,
#if MINIMAL_RUNTIME
      'wasm': Module['wasm'],
#else
      'wasm': wasmModule,
#endif
      'mem': wasmMemory,
      'sb': stackLowestAddress, // sb = stack bottom (lowest stack address, SP points at this when stack is full)
      'sz': stackSize,          // sz = stack size
    });
    worker.onmessage = _wasmWorkerRunPostMessage;
#if ENVIRONMENT_MAY_BE_NODE
    if (ENVIRONMENT_IS_NODE) {
      /** @suppress {checkTypes} */
      worker.on('message', (msg) => worker.onmessage({ data: msg }));
    }
#endif
    return _wasmWorkersID++;
  },

  emscripten_terminate_wasm_worker: (id) => {
#if ASSERTIONS
    assert(id != 0, 'emscripten_terminate_wasm_worker() cannot be called with id=0!');
#endif
    if (_wasmWorkers[id]) {
      _wasmWorkers[id].terminate();
      delete _wasmWorkers[id];
    }
  },

  emscripten_terminate_all_wasm_workers: () => {
#if ASSERTIONS
    assert(!ENVIRONMENT_IS_WASM_WORKER, 'emscripten_terminate_all_wasm_workers() cannot be called from a Wasm Worker: only the main browser thread has visibility to terminate all Workers!');
#endif
    Object.values(_wasmWorkers).forEach((worker) => worker.terminate());
    _wasmWorkers = {};
  },

  emscripten_current_thread_is_wasm_worker: () => {
#if WASM_WORKERS
    return ENVIRONMENT_IS_WASM_WORKER;
#else
    // implicit return 0;
#endif
  },

  emscripten_wasm_worker_self_id: () => Module['$ww'],

  emscripten_wasm_worker_post_function_v: (id, funcPtr) => {
    _wasmWorkers[id].postMessage({'_wsc': funcPtr, 'x': [] }); // "WaSm Call"
  },

  $_wasmWorkerPostFunction1__sig: 'vipd',
  $_wasmWorkerPostFunction1: (id, funcPtr, arg0) => {
    _wasmWorkers[id].postMessage({'_wsc': funcPtr, 'x': [arg0] }); // "WaSm Call"
  },

  emscripten_wasm_worker_post_function_vi: '$_wasmWorkerPostFunction1',
  emscripten_wasm_worker_post_function_vd: '$_wasmWorkerPostFunction1',

  $_wasmWorkerPostFunction2__sig: 'vipdd',
  $_wasmWorkerPostFunction2: (id, funcPtr, arg0, arg1) => {
    _wasmWorkers[id].postMessage({'_wsc': funcPtr, 'x': [arg0, arg1] }); // "WaSm Call"
  },
  emscripten_wasm_worker_post_function_vii: '$_wasmWorkerPostFunction2',
  emscripten_wasm_worker_post_function_vdd: '$_wasmWorkerPostFunction2',

  $_wasmWorkerPostFunction3__sig: 'vipddd',
  $_wasmWorkerPostFunction3: (id, funcPtr, arg0, arg1, arg2) => {
    _wasmWorkers[id].postMessage({'_wsc': funcPtr, 'x': [arg0, arg1, arg2] }); // "WaSm Call"
  },
  emscripten_wasm_worker_post_function_viii: '$_wasmWorkerPostFunction3',
  emscripten_wasm_worker_post_function_vddd: '$_wasmWorkerPostFunction3',

  emscripten_wasm_worker_post_function_sig__deps: ['$readEmAsmArgs'],
  emscripten_wasm_worker_post_function_sig: (id, funcPtr, sigPtr, varargs) => {
#if ASSERTIONS
    assert(id >= 0);
    assert(funcPtr);
    assert(sigPtr);
    assert(UTF8ToString(sigPtr)[0] != 'v', 'Do NOT specify the return argument in the signature string for a call to emscripten_wasm_worker_post_function_sig(), just pass the function arguments.');
    assert(varargs);
#endif
    _wasmWorkers[id].postMessage({'_wsc': funcPtr, 'x': readEmAsmArgs(sigPtr, varargs) });
  },

  emscripten_navigator_hardware_concurrency: () => {
#if ENVIRONMENT_MAY_BE_NODE
    if (ENVIRONMENT_IS_NODE) return require('os').cpus().length;
#endif
    return navigator['hardwareConcurrency'];
  },

  emscripten_atomics_is_lock_free: (width) => {
    return Atomics.isLockFree(width);
  },

  emscripten_lock_async_acquire__deps: ['$polyfillWaitAsync'],
  emscripten_lock_async_acquire: (lock, asyncWaitFinished, userData, maxWaitMilliseconds) => {
    let dispatch = (val, ret) => {
      setTimeout(() => {
        {{{ makeDynCall('vpiip', 'asyncWaitFinished') }}}(lock, val, /*waitResult=*/ret, userData);
      }, 0);
    };
    let tryAcquireLock = () => {
      do {
        var val = Atomics.compareExchange(HEAP32, {{{ getHeapOffset('lock', 'i32') }}}, 0/*zero represents lock being free*/, 1/*one represents lock being acquired*/);
        if (!val) return dispatch(0, 0/*'ok'*/);
        var wait = Atomics.waitAsync(HEAP32, {{{ getHeapOffset('lock', 'i32') }}}, val, maxWaitMilliseconds);
      } while (wait.value === 'not-equal');
#if ASSERTIONS
      assert(wait.async || wait.value === 'timed-out');
#endif
      if (wait.async) wait.value.then(tryAcquireLock);
      else dispatch(val, 2/*'timed-out'*/);
    };
    tryAcquireLock();
  },

  emscripten_semaphore_async_acquire__deps: ['$polyfillWaitAsync'],
  emscripten_semaphore_async_acquire: (sem, num, asyncWaitFinished, userData, maxWaitMilliseconds) => {
    let dispatch = (idx, ret) => {
      setTimeout(() => {
        {{{ makeDynCall('viiii', 'asyncWaitFinished') }}}(sem, /*val=*/idx, /*waitResult=*/ret, userData);
      }, 0);
    };
    let tryAcquireSemaphore = () => {
      let val = num;
      do {
        let ret = Atomics.compareExchange(HEAP32, {{{ getHeapOffset('sem', 'i32') }}},
                                          val, /* We expect this many semaphore resources to be available*/
                                          val - num /* Acquire 'num' of them */);
        if (ret == val) return dispatch(ret/*index of resource acquired*/, 0/*'ok'*/);
        val = ret;
        let wait = Atomics.waitAsync(HEAP32, {{{ getHeapOffset('sem', 'i32') }}}, ret, maxWaitMilliseconds);
      } while (wait.value === 'not-equal');
#if ASSERTIONS
      assert(wait.async || wait.value === 'timed-out');
#endif
      if (wait.async) wait.value.then(tryAcquireSemaphore);
      else dispatch(-1/*idx*/, 2/*'timed-out'*/);
    };
    tryAcquireSemaphore();
  }
});
