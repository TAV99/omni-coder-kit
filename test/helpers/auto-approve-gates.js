'use strict';

// For suites written before human approval gates (SPEC-SQUAD-P3 §5): approve
// every gate in-process so they keep testing what they tested. Gate behaviour
// itself is covered in dual-approval-gates.test.js.
require('../../lib/dual/approval-gates').setTestApprover(() => true);
