---
name: cpp-systems-safety
description: "C++20 & Node.js native engine rules: memory safety, SIMD vectorization, sanitizers, and zero-copy performance for quant trading backtests."
---

# C++ Systems Safety & Performance Skill

## Core Principles
1. **Modern C++20 Standards**:
   - Utilize RAII strictly for all resource management. Never use raw owning pointers (`new`/`delete`). Prefer `std::unique_ptr` and `std::shared_ptr`.
   - Prefer `std::span` and `std::string_view` for non-owning views over allocations or copies.
   - Use `const` correctness and `constexpr`/`consteval` for compile-time lookup tables and mathematical constants.

2. **Node.js Native Addon (N-API / node-addon-api)**:
   - Always validate arguments passed from JavaScript before unwrapping native pointers.
   - Use `napi_create_buffer_copy` or direct `napi_get_buffer_info` for zero-copy memory transfers between V8 and C++ execution engines.
   - When executing asynchronous compute workloads or GPU simulations, dispatch via `Napi::AsyncWorker` or thread pools to prevent blocking the Node.js event loop.

3. **Memory Safety & Sanitizer Tooling**:
   - Compile and test with AddressSanitizer (`-fsanitize=address`) and UndefinedBehaviorSanitizer (`-fsanitize=undefined`) during debug runs.
   - Use Valgrind (`valgrind --leak-check=full`) on native test binaries to guarantee zero memory leaks before committing code.

4. **Performance & Math Correctness**:
   - Minimize heap allocations in hot inner loops (candle evaluation, moving average calculation, order book state updates).
   - Pre-allocate vectors (`std::vector::reserve`) when processing historical price bars.
   - Avoid floating-point comparison pitfalls: use epsilon comparisons (`std::abs(a - b) < 1e-6`) or fixed-point integer cents (milliemes/piastres) for price matching.
