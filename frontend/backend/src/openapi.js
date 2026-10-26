// OpenAPI 3.0 specification for the Vision Health Care REST API.
// Served as raw JSON at /api/openapi.json and as interactive docs (Swagger UI) at /api/docs.
// Kept in step with the routers under src/routes; group tags mirror the mounted path prefixes.

const bearerNote =
  'Session is a HttpOnly cookie (`vhc_sid`) set by `POST /api/auth/login` (customers/staff) or ' +
  '`POST /api/life-claims/portal/verify` (claimants). State-changing requests (POST/PUT/PATCH/DELETE) ' +
  'must also send the CSRF token — returned in the login/me responses and in the `vhc_csrf` cookie — ' +
  'in the `X-CSRF-Token` header.';

// ---- reusable response/parameter helpers -------------------------------------------------
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const jsonBody = (schema, required = true) => ({
  required,
  content: { 'application/json': { schema } },
});
const jsonResp = (description, schema) => ({
  description,
  ...(schema ? { content: { 'application/json': { schema } } } : {}),
});

const errorResponse = (description) => ({
  description,
  content: { 'application/json': { schema: ref('Error') } },
});

// Error responses reused across many operations.
const R = {
  400: errorResponse('Bad request — validation or malformed input.'),
  401: errorResponse('Not authenticated, or the session has expired/been revoked.'),
  403: errorResponse('Authenticated but not permitted (wrong role, or CSRF check failed).'),
  404: errorResponse('The requested resource does not exist or is not visible to you.'),
  409: errorResponse('Conflict — the resource is not in a state that allows this action.'),
  422: errorResponse('Unprocessable — the submission is incomplete; see `details`.'),
  429: errorResponse('Too many requests — throttled; retry after a short wait.'),
};

const pathParam = (name, description) => ({
  name, in: 'path', required: true, description, schema: { type: 'string' },
});
const queryParam = (name, description, schema = { type: 'string' }) => ({
  name, in: 'query', required: false, description, schema,
});

// ---- schemas ------------------------------------------------------------------------------
const schemas = {
  Error: {
    type: 'object',
    properties: {
      error: { type: 'string', description: 'Human-readable error message.' },
      details: {
        type: 'object',
        description: 'Optional structured detail: `fields` for form errors, `problems` for a list, `errors`, `attemptsLeft`, etc.',
        additionalProperties: true,
      },
    },
    required: ['error'],
  },
  Health: {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      name: { type: 'string' },
      time: { type: 'string', format: 'date-time' },
    },
  },
  Money: {
    type: 'integer',
    description: 'Monetary amount in paise (1 INR = 100 paise). Never a floating-point rupee value.',
    example: 2500000,
  },
  SessionInfo: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
      lastSeenAt: { type: 'string', format: 'date-time' },
      remembered: { type: 'boolean' },
      userAgent: { type: 'string' },
      current: { type: 'boolean', description: 'Present on the /auth/sessions listing.' },
    },
  },
  User: {
    type: 'object',
    description: 'Public projection of a user (customer or staff). Sensitive fields (passwordHash) are never returned.',
    properties: {
      id: { type: 'string' },
      role: { type: 'string', enum: ['customer', 'claimant', 'agent', 'underwriter', 'claims_officer', 'admin'] },
      customerId: { type: 'string', nullable: true },
      name: { type: 'string' },
      legalName: { type: 'string' },
      email: { type: 'string', format: 'email' },
      emailVerified: { type: 'boolean' },
      mobile: { type: 'string' },
      mobileVerified: { type: 'boolean' },
      status: { type: 'string', enum: ['Pending Verification', 'Active', 'Invited', 'Disabled'] },
      active: { type: 'boolean' },
      profile: { type: 'object', additionalProperties: true },
      communicationPreference: { type: 'string', enum: ['email', 'email_sms'] },
      marketingOptIn: { type: 'boolean' },
    },
  },
  AuthContext: {
    type: 'object',
    description: 'Returned by login and /auth/me: the current user plus the CSRF token to echo on mutations.',
    properties: {
      user: ref('User'),
      csrfToken: { type: 'string' },
      session: ref('SessionInfo'),
    },
  },
  Challenge: {
    type: 'object',
    description: 'An OTP challenge. In non-production, `devCode`/`devOtp` echoes the code for testing.',
    properties: {
      challengeId: { type: 'string' },
      destination: { type: 'string', description: 'Masked email or mobile the code was sent to.' },
      expiresAt: { type: 'string', format: 'date-time' },
      attemptsRemaining: { type: 'integer' },
      devCode: { type: 'string', description: 'Non-production only.' },
    },
  },
  Message: {
    type: 'object',
    properties: { message: { type: 'string' } },
  },
  Ok: {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
  },
  Plan: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      code: { type: 'string' },
      name: { type: 'string' },
      product: { type: 'string', enum: ['health', 'life'] },
      type: { type: 'string' },
      description: { type: 'string' },
      active: { type: 'boolean' },
      version: { type: 'integer' },
      config: { type: 'object', additionalProperties: true, description: 'Current version config (age bands, coverage options, rate tables, etc.).' },
      versions: { type: 'integer', description: 'Number of published versions.' },
    },
  },
  Quote: {
    type: 'object',
    description: 'A premium quote. Shape differs by product; common fields shown.',
    properties: {
      planId: { type: 'string' },
      planVersion: { type: 'integer' },
      product: { type: 'string', enum: ['health', 'life'] },
      coverage: ref('Money'),
      sumAssured: ref('Money'),
      annualPremium: ref('Money'),
      totalAnnualPremium: ref('Money'),
      installmentPremium: ref('Money'),
      underwritingRequired: { type: 'boolean' },
      expiresAt: { type: 'string', format: 'date-time' },
    },
    additionalProperties: true,
  },
  ApplicationSummary: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      applicationNumber: { type: 'string' },
      product: { type: 'string', enum: ['health', 'life'] },
      planName: { type: 'string' },
      status: { type: 'string' },
      customerName: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
      submittedAt: { type: 'string', format: 'date-time', nullable: true },
      premium: { allOf: [ref('Money')], nullable: true },
      underwritingRequired: { type: 'boolean' },
      renewalOf: { type: 'string', nullable: true },
      policyId: { type: 'string', nullable: true },
    },
  },
  Application: {
    type: 'object',
    description: 'Full application view. Customers do not see internal underwriting/review notes; staff see an extra `checklist`.',
    additionalProperties: true,
    properties: {
      id: { type: 'string' },
      applicationNumber: { type: 'string' },
      product: { type: 'string', enum: ['health', 'life'] },
      status: { type: 'string' },
      planId: { type: 'string' },
      planName: { type: 'string' },
      startDate: { type: 'string', format: 'date' },
      quote: { allOf: [ref('Quote')], nullable: true },
      offer: { type: 'object', additionalProperties: true, nullable: true },
      editable: { type: 'boolean' },
      quoteValid: { type: 'boolean' },
      health: { type: 'object', additionalProperties: true, nullable: true },
      life: { type: 'object', additionalProperties: true, nullable: true },
      timeline: { type: 'array', items: { type: 'object', additionalProperties: true } },
    },
  },
  Policy: {
    type: 'object',
    additionalProperties: true,
    properties: {
      id: { type: 'string' },
      policyNumber: { type: 'string' },
      product: { type: 'string', enum: ['health', 'life'] },
      planName: { type: 'string' },
      status: { type: 'string' },
      startDate: { type: 'string', format: 'date' },
      endDate: { type: 'string', format: 'date' },
      coverage: ref('Money'),
      sumAssured: ref('Money'),
      members: { type: 'array', items: { type: 'object', additionalProperties: true } },
    },
  },
  Payment: {
    type: 'object',
    additionalProperties: true,
    properties: {
      id: { type: 'string' },
      reference: { type: 'string' },
      userId: { type: 'string' },
      purpose: { type: 'string', enum: ['application', 'premium', 'reinstatement'] },
      policyId: { type: 'string', nullable: true },
      applicationId: { type: 'string', nullable: true },
      amount: ref('Money'),
      status: { type: 'string', enum: ['pending', 'success', 'failed', 'refund_due', 'refunded'] },
      description: { type: 'string' },
      createdAt: { type: 'string', format: 'date-time' },
      completedAt: { type: 'string', format: 'date-time', nullable: true },
    },
  },
  HealthClaimSummary: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      claimNumber: { type: 'string' },
      type: { type: 'string', enum: ['cashless', 'reimbursement'] },
      status: { type: 'string' },
      policyNumber: { type: 'string' },
      memberName: { type: 'string' },
      hospitalName: { type: 'string' },
      admissionDate: { type: 'string', format: 'date' },
      requestedAmount: ref('Money'),
      approvedAmount: { allOf: [ref('Money')], nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  HealthClaim: { type: 'object', additionalProperties: true, description: 'Full health-claim view, including policy/member context and payouts.' },
  LifeClaimSummary: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      claimNumber: { type: 'string' },
      policyNumber: { type: 'string' },
      lifeAssuredName: { type: 'string' },
      claimantName: { type: 'string' },
      dateOfDeath: { type: 'string', format: 'date' },
      status: { type: 'string' },
      flagged: { type: 'boolean' },
      approvedAmount: { allOf: [ref('Money')], nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  LifeClaim: { type: 'object', additionalProperties: true, description: 'Full life-claim view; staff additionally get `analysis` and `payouts`.' },
  Payout: { type: 'object', additionalProperties: true },
  Reinstatement: { type: 'object', additionalProperties: true },
  Hospital: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      address: { type: 'string' },
      city: { type: 'string' },
      state: { type: 'string' },
      postalCode: { type: 'string' },
      phone: { type: 'string' },
      email: { type: 'string' },
      specialties: { type: 'array', items: { type: 'string' } },
      network: { type: 'boolean' },
      active: { type: 'boolean' },
    },
  },
  Document: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      entityType: { type: 'string', enum: ['application', 'policy', 'healthClaim', 'lifeClaim'] },
      entityId: { type: 'string' },
      category: { type: 'string' },
      description: { type: 'string' },
      filename: { type: 'string' },
      mime: { type: 'string', enum: ['application/pdf', 'image/png', 'image/jpeg'] },
      size: { type: 'integer' },
      uploadedByName: { type: 'string' },
      uploadedByRole: { type: 'string' },
      restricted: { type: 'boolean', description: 'True when an agent is barred from a medical category.' },
    },
  },
  Notification: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      userId: { type: 'string' },
      title: { type: 'string' },
      message: { type: 'string' },
      type: { type: 'string' },
      read: { type: 'boolean' },
      link: { type: 'string', nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  FamilyMember: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      userId: { type: 'string' },
      fullName: { type: 'string' },
      dob: { type: 'string', format: 'date' },
      relationship: { type: 'string', enum: ['spouse', 'child', 'parent', 'sibling', 'parent-in-law', 'other'] },
      gender: { type: 'string', enum: ['', 'female', 'male', 'other'] },
      status: { type: 'string', enum: ['active', 'archived'] },
      version: { type: 'integer' },
    },
  },
  AiAnswer: {
    type: 'object',
    properties: {
      answer: { type: 'string' },
      mode: { type: 'string' },
      citations: { type: 'array', items: { type: 'string' } },
      abstained: { type: 'boolean' },
      urgent: { type: 'boolean' },
    },
  },
};

// ---- paths --------------------------------------------------------------------------------
const paths = {
  '/health': {
    get: {
      tags: ['Meta'], summary: 'Service health check', security: [],
      responses: { 200: jsonResp('Service is up.', ref('Health')) },
    },
  },
  '/openapi.json': {
    get: { tags: ['Meta'], summary: 'This OpenAPI document (raw JSON)', security: [], responses: { 200: jsonResp('The spec.') } },
  },

  // -------- Auth (VHC-M01/M02/M03) --------
  '/auth/register': {
    post: {
      tags: ['Auth'], summary: 'Register a new customer account', security: [],
      description: 'Always creates a Customer. Responds 202 with a neutral message regardless of whether the email already exists.',
      requestBody: jsonBody({
        type: 'object',
        required: ['firstName', 'email', 'mobile', 'password', 'confirmPassword', 'acceptTerms'],
        properties: {
          firstName: { type: 'string' },
          lastName: { type: 'string' },
          email: { type: 'string', format: 'email' },
          mobile: { type: 'string', description: '10-digit Indian mobile number.' },
          password: { type: 'string', format: 'password' },
          confirmPassword: { type: 'string', format: 'password' },
          acceptTerms: { type: 'boolean' },
          marketingOptIn: { type: 'boolean' },
        },
      }),
      responses: { 202: jsonResp('Accepted (neutral response).', ref('Message')), 422: R[422] },
    },
  },
  '/auth/verify-email': {
    post: {
      tags: ['Auth'], summary: 'Verify an email address (or confirm an email change)', security: [],
      requestBody: jsonBody({ type: 'object', required: ['token'], properties: { token: { type: 'string' } } }),
      responses: { 200: jsonResp('Verified.', ref('Message')), 400: R[400] },
    },
  },
  '/auth/resend-verification': {
    post: {
      tags: ['Auth'], summary: 'Resend the email verification link', security: [],
      requestBody: jsonBody({ type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' } } }),
      responses: { 200: jsonResp('Neutral response.', ref('Message')), 400: R[400], 429: R[429] },
    },
  },
  '/auth/mobile/send': {
    post: {
      tags: ['Auth'], summary: 'Send an OTP to verify the mobile number',
      responses: { 201: jsonResp('OTP sent.', ref('Challenge')), 401: R[401], 409: R[409] },
    },
  },
  '/auth/mobile/verify': {
    post: {
      tags: ['Auth'], summary: 'Verify the mobile OTP',
      requestBody: jsonBody({ type: 'object', required: ['challengeId', 'code'], properties: { challengeId: { type: 'string' }, code: { type: 'string' } } }),
      responses: { 200: jsonResp('Mobile verified.', { type: 'object', properties: { message: { type: 'string' }, user: ref('User') } }), 400: R[400], 401: R[401] },
    },
  },
  '/auth/login': {
    post: {
      tags: ['Auth'], summary: 'Sign in (customer or staff)', security: [],
      description: 'Sets the `vhc_sid` and `vhc_csrf` cookies and returns the CSRF token to use for mutations.',
      requestBody: jsonBody({
        type: 'object', required: ['email', 'password'],
        properties: { email: { type: 'string', format: 'email' }, password: { type: 'string', format: 'password' }, rememberDevice: { type: 'boolean' } },
      }),
      responses: { 200: jsonResp('Signed in.', ref('AuthContext')), 400: R[400], 401: R[401], 403: R[403], 429: R[429] },
    },
  },
  '/auth/logout': {
    post: { tags: ['Auth'], summary: 'Sign out of the current session', responses: { 200: jsonResp('Signed out.', ref('Message')), 401: R[401] } },
  },
  '/auth/me': {
    get: { tags: ['Auth'], summary: 'Current user and CSRF token', responses: { 200: jsonResp('Current auth context.', ref('AuthContext')), 401: R[401] } },
  },
  '/auth/sessions': {
    get: { tags: ['Auth'], summary: 'List active sessions for the current user', responses: { 200: jsonResp('Active sessions.', { type: 'array', items: ref('SessionInfo') }), 401: R[401] } },
  },
  '/auth/sessions/{id}/revoke': {
    post: { tags: ['Auth'], summary: 'Revoke one session', parameters: [pathParam('id', 'Session id.')], responses: { 200: jsonResp('Revoked.', ref('Ok')), 401: R[401], 404: R[404] } },
  },
  '/auth/change-password': {
    post: {
      tags: ['Auth'], summary: 'Change password (signs out other devices)',
      requestBody: jsonBody({ type: 'object', required: ['currentPassword', 'newPassword', 'confirmPassword'], properties: { currentPassword: { type: 'string', format: 'password' }, newPassword: { type: 'string', format: 'password' }, confirmPassword: { type: 'string', format: 'password' } } }),
      responses: { 200: jsonResp('Password changed.', ref('Message')), 400: R[400], 401: R[401], 422: R[422] },
    },
  },
  '/auth/forgot-password': {
    post: { tags: ['Auth'], summary: 'Request a password-reset link', security: [], requestBody: jsonBody({ type: 'object', required: ['email'], properties: { email: { type: 'string', format: 'email' } } }), responses: { 200: jsonResp('Neutral response.', ref('Message')), 400: R[400] } },
  },
  '/auth/reset-password/check': {
    get: { tags: ['Auth'], summary: 'Check a reset-link token is valid', security: [], parameters: [queryParam('token', 'The reset token.')], responses: { 200: jsonResp('Valid.', { type: 'object', properties: { valid: { type: 'boolean' }, expiresAt: { type: 'string', format: 'date-time' } } }), 400: R[400] } },
  },
  '/auth/reset-password': {
    post: { tags: ['Auth'], summary: 'Set a new password with a reset token', security: [], requestBody: jsonBody({ type: 'object', required: ['token', 'password', 'confirmPassword'], properties: { token: { type: 'string' }, password: { type: 'string', format: 'password' }, confirmPassword: { type: 'string', format: 'password' } } }), responses: { 200: jsonResp('Reset.', ref('Message')), 400: R[400], 422: R[422] } },
  },
  '/auth/invite/check': {
    get: { tags: ['Auth'], summary: 'Check a staff invitation token', security: [], parameters: [queryParam('token', 'Invitation token.')], responses: { 200: jsonResp('Valid invitation.', { type: 'object', additionalProperties: true }), 400: R[400] } },
  },
  '/auth/accept-invite': {
    post: { tags: ['Auth'], summary: 'Accept a staff invitation and set a password', security: [], requestBody: jsonBody({ type: 'object', required: ['token', 'password', 'confirmPassword'], properties: { token: { type: 'string' }, password: { type: 'string', format: 'password' }, confirmPassword: { type: 'string', format: 'password' } } }), responses: { 200: jsonResp('Account ready.', ref('Message')), 400: R[400], 422: R[422] } },
  },

  // -------- Profile (VHC-M04) --------
  '/profile': {
    get: { tags: ['Profile'], summary: 'Current user profile (with list of valid states)', responses: { 200: jsonResp('Profile.', { allOf: [ref('User')], type: 'object' }), 401: R[401], 403: R[403] } },
  },
  '/profile/personal': {
    put: { tags: ['Profile'], summary: 'Update personal details', requestBody: jsonBody({ type: 'object', required: ['legalName'], properties: { legalName: { type: 'string' }, dob: { type: 'string', format: 'date' }, gender: { type: 'string', enum: ['female', 'male', 'other', 'undisclosed'] } } }), responses: { 200: jsonResp('Updated.', ref('User')), 401: R[401], 422: R[422] } },
  },
  '/profile/address': {
    put: { tags: ['Profile'], summary: 'Update address', requestBody: jsonBody({ type: 'object', required: ['line1', 'city', 'state', 'postalCode'], properties: { line1: { type: 'string' }, line2: { type: 'string' }, city: { type: 'string' }, state: { type: 'string' }, postalCode: { type: 'string', description: '6-digit postal code.' } } }), responses: { 200: jsonResp('Updated.', ref('User')), 401: R[401], 422: R[422] } },
  },
  '/profile/preferences': {
    put: { tags: ['Profile'], summary: 'Update communication preferences', requestBody: jsonBody({ type: 'object', required: ['communicationPreference'], properties: { communicationPreference: { type: 'string', enum: ['email', 'email_sms'] }, marketingOptIn: { type: 'boolean' } } }), responses: { 200: jsonResp('Updated.', ref('User')), 401: R[401], 422: R[422] } },
  },
  '/profile/email-change': {
    post: { tags: ['Profile'], summary: 'Request an email change (verify before it applies)', requestBody: jsonBody({ type: 'object', required: ['newEmail'], properties: { newEmail: { type: 'string', format: 'email' } } }), responses: { 202: jsonResp('Verification sent.', ref('Message')), 401: R[401], 422: R[422] } },
  },
  '/profile/mobile-change': {
    post: { tags: ['Profile'], summary: 'Request a mobile change (OTP)', requestBody: jsonBody({ type: 'object', required: ['newMobile'], properties: { newMobile: { type: 'string' } } }), responses: { 201: jsonResp('OTP sent.', ref('Challenge')), 401: R[401], 422: R[422] } },
  },
  '/profile/cancel-contact-change': {
    post: { tags: ['Profile'], summary: 'Cancel a pending email/mobile change', requestBody: jsonBody({ type: 'object', properties: { type: { type: 'string', enum: ['email', 'mobile'] } } }), responses: { 200: jsonResp('Cancelled.', ref('User')), 401: R[401] } },
  },
  '/profile/customers/{id}': {
    get: { tags: ['Profile'], summary: 'Read a customer profile (agent/underwriter/admin)', parameters: [pathParam('id', 'Customer user id.')], responses: { 200: jsonResp('Masked customer profile.', ref('User')), 401: R[401], 403: R[403], 404: R[404] } },
  },

  // -------- Dashboard (VHC-M05) --------
  '/dashboard': {
    get: {
      tags: ['Dashboard'], summary: 'Customer dashboard (KPIs, policy cards, actions, activity)',
      parameters: [
        queryParam('product', 'Filter by product.', { type: 'string', enum: ['all', 'health', 'life'], default: 'all' }),
        queryParam('from', 'Activity window start (YYYY-MM-DD).', { type: 'string', format: 'date' }),
        queryParam('to', 'Activity window end (YYYY-MM-DD).', { type: 'string', format: 'date' }),
      ],
      responses: { 200: jsonResp('Dashboard payload.', { type: 'object', additionalProperties: true }), 400: R[400], 401: R[401], 403: R[403] },
    },
  },

  // -------- Plans --------
  '/plans': {
    get: {
      tags: ['Plans'], summary: 'List active plans', security: [],
      parameters: [queryParam('product', 'health | life', { type: 'string', enum: ['health', 'life'] }), queryParam('type', 'Plan type.'), queryParam('includeInactive', 'Admin only: include inactive plans.', { type: 'string', enum: ['true', 'false'] })],
      responses: { 200: jsonResp('Plans.', { type: 'array', items: ref('Plan') }) },
    },
  },
  '/plans/compare': {
    get: { tags: ['Plans'], summary: 'Compare plans by id', security: [], parameters: [queryParam('ids', 'Comma-separated plan ids.')], responses: { 200: jsonResp('Plans.', { type: 'array', items: ref('Plan') }) } },
  },
  '/plans/{id}': {
    get: { tags: ['Plans'], summary: 'Get a plan', security: [], parameters: [pathParam('id', 'Plan id.')], responses: { 200: jsonResp('Plan.', ref('Plan')), 404: R[404] } },
  },

  // -------- Quotes --------
  '/quotes/health': {
    post: { tags: ['Quotes'], summary: 'Calculate a health quote (anonymous allowed)', security: [], requestBody: jsonBody({ type: 'object', required: ['planId'], additionalProperties: true, properties: { planId: { type: 'string' }, coverage: ref('Money'), members: { type: 'array', items: { type: 'object', additionalProperties: true } } } }), responses: { 200: jsonResp('Quote.', ref('Quote')), 404: R[404] } },
  },
  '/quotes/life': {
    post: { tags: ['Quotes'], summary: 'Calculate a life quote (anonymous allowed)', security: [], requestBody: jsonBody({ type: 'object', required: ['planId'], additionalProperties: true, properties: { planId: { type: 'string' }, sumAssured: ref('Money'), policyTerm: { type: 'integer' } } }), responses: { 200: jsonResp('Quote.', ref('Quote')), 404: R[404] } },
  },

  // -------- Applications --------
  '/applications': {
    get: {
      tags: ['Applications'], summary: 'List applications (own for customers; all submitted for staff)',
      parameters: [queryParam('status', 'Filter by status.'), queryParam('product', 'health | life.'), queryParam('bucket', 'Named bucket filter (e.g. pending).')],
      responses: { 200: jsonResp('Applications.', { type: 'array', items: ref('ApplicationSummary') }), 401: R[401] },
    },
    post: { tags: ['Applications'], summary: 'Create a draft application (customer)', requestBody: jsonBody({ type: 'object', required: ['planId'], properties: { planId: { type: 'string' }, coverage: ref('Money') } }), responses: { 201: jsonResp('Created.', ref('Application')), 401: R[401], 403: R[403], 404: R[404] } },
  },
  '/applications/{id}': {
    get: { tags: ['Applications'], summary: 'Get an application', parameters: [pathParam('id', 'Application id.')], responses: { 200: jsonResp('Application.', ref('Application')), 401: R[401], 403: R[403], 404: R[404] } },
    put: { tags: ['Applications'], summary: 'Edit a draft/editable application (customer)', parameters: [pathParam('id', 'Application id.')], requestBody: jsonBody({ type: 'object', additionalProperties: true, properties: { startDate: { type: 'string', format: 'date' }, coverage: ref('Money'), members: { type: 'array', items: { type: 'object', additionalProperties: true } }, life: { type: 'object', additionalProperties: true }, nominees: { type: 'array', items: { type: 'object', additionalProperties: true } }, consent: { type: 'boolean' } } }), responses: { 200: jsonResp('Updated.', ref('Application')), 400: R[400], 401: R[401], 409: R[409] } },
  },
  '/applications/{id}/quote': {
    post: { tags: ['Applications'], summary: 'Recalculate the quote for an application (customer)', parameters: [pathParam('id', 'Application id.')], responses: { 200: jsonResp('Application with fresh quote.', ref('Application')), 401: R[401], 409: R[409] } },
  },
  '/applications/{id}/validate-nominees': {
    post: { tags: ['Applications'], summary: 'Validate nominee allocations (customer)', parameters: [pathParam('id', 'Application id.')], requestBody: jsonBody({ type: 'object', properties: { nominees: { type: 'array', items: { type: 'object', additionalProperties: true } } } }), responses: { 200: jsonResp('Validation result.', { type: 'object', properties: { valid: { type: 'boolean' }, errors: { type: 'array', items: { type: 'string' } }, normalized: { type: 'array', items: { type: 'object', additionalProperties: true } } } }), 401: R[401] } },
  },
  '/applications/{id}/submit': {
    post: { tags: ['Applications'], summary: 'Submit an application for review (customer)', parameters: [pathParam('id', 'Application id.')], responses: { 200: jsonResp('Submitted (or idempotent current state).', ref('Application')), 401: R[401], 409: R[409], 422: R[422] } },
  },
  '/applications/{id}/accept-offer': {
    post: { tags: ['Applications'], summary: 'Accept an approved offer (customer)', parameters: [pathParam('id', 'Application id.')], responses: { 200: jsonResp('Accepted.', ref('Application')), 401: R[401], 409: R[409] } },
  },
  '/applications/{id}/decline-offer': {
    post: { tags: ['Applications'], summary: 'Decline an approved offer (customer)', parameters: [pathParam('id', 'Application id.')], requestBody: jsonBody({ type: 'object', properties: { reason: { type: 'string' } } }, false), responses: { 200: jsonResp('Declined.', ref('Application')), 401: R[401], 409: R[409] } },
  },
  '/applications/{id}/reopen': {
    post: { tags: ['Applications'], summary: 'Reopen an approved, unpaid application to change declarations (customer)', parameters: [pathParam('id', 'Application id.')], requestBody: jsonBody({ type: 'object', properties: { reason: { type: 'string' } } }, false), responses: { 200: jsonResp('Reopened.', ref('Application')), 401: R[401], 409: R[409] } },
  },
  '/applications/{id}/review/start': {
    post: { tags: ['Applications'], summary: 'Start initial review (agent/underwriter/admin)', parameters: [pathParam('id', 'Application id.')], responses: { 200: jsonResp('In review.', ref('Application')), 401: R[401], 403: R[403], 409: R[409] } },
  },
  '/applications/{id}/review/request-correction': {
    post: { tags: ['Applications'], summary: 'Request a correction from the customer (reviewer)', parameters: [pathParam('id', 'Application id.')], requestBody: jsonBody({ type: 'object', required: ['note'], properties: { note: { type: 'string' } } }), responses: { 200: jsonResp('Correction requested.', ref('Application')), 400: R[400], 401: R[401], 403: R[403], 409: R[409] } },
  },
  '/applications/{id}/review/forward': {
    post: { tags: ['Applications'], summary: 'Forward to underwriting (reviewer)', parameters: [pathParam('id', 'Application id.')], requestBody: jsonBody({ type: 'object', properties: { note: { type: 'string' } } }, false), responses: { 200: jsonResp('Forwarded.', ref('Application')), 401: R[401], 403: R[403], 409: R[409] } },
  },
  '/applications/{id}/notes': {
    post: { tags: ['Applications'], summary: 'Add an internal note (agent/underwriter/admin)', parameters: [pathParam('id', 'Application id.')], requestBody: jsonBody({ type: 'object', required: ['note'], properties: { note: { type: 'string' } } }), responses: { 200: jsonResp('Noted.', ref('Application')), 400: R[400], 401: R[401], 403: R[403] } },
  },
  '/applications/{id}/underwriting/requirements': {
    post: { tags: ['Applications'], summary: 'Add an underwriting requirement (underwriter/admin)', parameters: [pathParam('id', 'Application id.')], requestBody: jsonBody({ type: 'object', required: ['type', 'description'], properties: { type: { type: 'string', enum: ['medical_test', 'exam', 'document', 'information'] }, description: { type: 'string' }, scheduledAt: { type: 'string', format: 'date-time' }, center: { type: 'string' } } }), responses: { 200: jsonResp('Requirement added.', ref('Application')), 400: R[400], 401: R[401], 403: R[403], 409: R[409] } },
  },
  '/applications/{id}/underwriting/requirements/{rid}': {
    post: { tags: ['Applications'], summary: 'Update a requirement: schedule | received | waive (underwriter/admin)', parameters: [pathParam('id', 'Application id.'), pathParam('rid', 'Requirement id.')], requestBody: jsonBody({ type: 'object', required: ['action'], properties: { action: { type: 'string', enum: ['schedule', 'received', 'waive'] }, scheduledAt: { type: 'string', format: 'date-time' }, center: { type: 'string' }, documentId: { type: 'string' }, note: { type: 'string' } } }), responses: { 200: jsonResp('Updated.', ref('Application')), 400: R[400], 401: R[401], 403: R[403], 404: R[404] } },
  },
  '/applications/{id}/underwriting/decision': {
    post: { tags: ['Applications'], summary: 'Record an underwriting decision: approve | revise | reject | postpone (underwriter/admin)', parameters: [pathParam('id', 'Application id.')], requestBody: jsonBody({ type: 'object', required: ['decision'], additionalProperties: true, properties: { decision: { type: 'string', enum: ['approve', 'revise', 'reject', 'postpone'] }, reason: { type: 'string' }, notes: { type: 'string' }, revisedCoverage: ref('Money'), loadingBp: { type: 'integer' }, uwClass: { type: 'string' }, extraLoadingBp: { type: 'integer' }, revisedSumAssured: ref('Money'), specialConditions: { type: 'string' } } }), responses: { 200: jsonResp('Decided.', ref('Application')), 400: R[400], 401: R[401], 403: R[403], 409: R[409] } },
  },

  // -------- Payments --------
  '/payments/callback': {
    post: { tags: ['Payments'], summary: 'Gateway webhook (simulated)', security: [], requestBody: jsonBody({ type: 'object', required: ['reference'], properties: { reference: { type: 'string' }, status: { type: 'string', enum: ['success', 'failed', 'pending'] }, amount: ref('Money') } }), responses: { 200: jsonResp('Processed.', { type: 'object', properties: { reference: { type: 'string' }, status: { type: 'string' }, duplicate: { type: 'boolean' } } }), 400: R[400] } },
  },
  '/payments': {
    get: { tags: ['Payments'], summary: 'List payments (own for customers; all for staff)', responses: { 200: jsonResp('Payments.', { type: 'array', items: ref('Payment') }), 401: R[401] } },
  },
  '/payments/initiate': {
    post: { tags: ['Payments'], summary: 'Initiate a payment (customer)', requestBody: jsonBody({ type: 'object', additionalProperties: true, properties: { purpose: { type: 'string', enum: ['application', 'premium', 'reinstatement'] }, applicationId: { type: 'string' }, policyId: { type: 'string' }, installmentNo: { type: 'integer' }, idempotencyKey: { type: 'string' } } }), responses: { 201: jsonResp('Initiated.', { type: 'object', additionalProperties: true }), 200: jsonResp('Replayed (idempotent).', { type: 'object', additionalProperties: true }), 401: R[401], 403: R[403] } },
  },
  '/payments/test-cards': {
    get: { tags: ['Payments'], summary: 'Published test cards and test OTP', responses: { 200: jsonResp('Test cards.', { type: 'object', additionalProperties: true }), 401: R[401] } },
  },
  '/payments/{reference}/simulate': {
    post: { tags: ['Payments'], summary: 'Drive the simulated gateway: success | failed | pending (customer/admin)', parameters: [pathParam('reference', 'Payment reference.')], requestBody: jsonBody({ type: 'object', properties: { outcome: { type: 'string', enum: ['success', 'failed', 'pending'] }, amount: ref('Money') } }, false), responses: { 200: jsonResp('Processed.', { type: 'object', additionalProperties: true }), 401: R[401], 403: R[403], 404: R[404] } },
  },
  '/payments/{reference}/card': {
    post: { tags: ['Payments'], summary: 'Test-mode card checkout (customer)', parameters: [pathParam('reference', 'Payment reference.')], requestBody: jsonBody({ type: 'object', required: ['number'], properties: { number: { type: 'string', description: 'A published test card number.' }, expMonth: { type: 'integer' }, expYear: { type: 'integer' }, cvv: { type: 'string' }, otp: { type: 'string', description: 'Required for 3-D Secure test cards.' } } }), responses: { 200: jsonResp('Outcome or requiresAction.', { type: 'object', additionalProperties: true }), 401: R[401], 403: R[403], 404: R[404], 409: R[409] } },
  },
  '/payments/{reference}': {
    get: { tags: ['Payments'], summary: 'Get a payment by reference', parameters: [pathParam('reference', 'Payment reference.')], responses: { 200: jsonResp('Payment.', ref('Payment')), 401: R[401], 404: R[404] } },
  },

  // -------- Policies --------
  '/policies': {
    get: { tags: ['Policies'], summary: 'List policies (own for customers; all for staff)', parameters: [queryParam('bucket', 'Named bucket filter (e.g. active, due).'), queryParam('product', 'health | life.')], responses: { 200: jsonResp('Policies.', { type: 'array', items: ref('Policy') }), 401: R[401] } },
  },
  '/policies/{id}': {
    get: { tags: ['Policies'], summary: 'Get a policy with claims, payments, renewal and reinstatements', parameters: [pathParam('id', 'Policy id.')], responses: { 200: jsonResp('Policy.', ref('Policy')), 401: R[401], 403: R[403], 404: R[404] } },
  },
  '/policies/{id}/pdf': {
    get: { tags: ['Policies'], summary: 'Download the policy document (PDF)', parameters: [pathParam('id', 'Policy id.')], responses: { 200: { description: 'PDF stream.', content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } }, 401: R[401], 403: R[403], 404: R[404] } },
  },
  '/policies/{id}/autopay': {
    post: { tags: ['Policies'], summary: 'Toggle auto-pay on a life policy (customer)', parameters: [pathParam('id', 'Policy id.')], requestBody: jsonBody({ type: 'object', properties: { enabled: { type: 'boolean' } } }), responses: { 200: jsonResp('Updated.', ref('Policy')), 400: R[400], 401: R[401] } },
  },
  '/policies/{id}/nominees': {
    post: { tags: ['Policies'], summary: 'Request a nominee change (life; OTP verified)', parameters: [pathParam('id', 'Policy id.')], requestBody: jsonBody({ type: 'object', required: ['nominees'], properties: { nominees: { type: 'array', items: { type: 'object', additionalProperties: true } } } }), responses: { 202: jsonResp('OTP sent.', ref('Challenge')), 400: R[400], 401: R[401], 409: R[409] } },
  },
  '/policies/{id}/nominees/verify': {
    post: { tags: ['Policies'], summary: 'Confirm a nominee change with OTP (life)', parameters: [pathParam('id', 'Policy id.')], requestBody: jsonBody({ type: 'object', required: ['otp'], properties: { otp: { type: 'string' } } }), responses: { 200: jsonResp('Updated.', ref('Policy')), 400: R[400], 401: R[401], 409: R[409] } },
  },
  '/policies/{id}/nominees/at': {
    get: { tags: ['Policies'], summary: 'Nominees effective on a given date (life)', parameters: [pathParam('id', 'Policy id.'), queryParam('date', 'YYYY-MM-DD (defaults to today).', { type: 'string', format: 'date' })], responses: { 200: jsonResp('Nominees.', { type: 'array', items: { type: 'object', additionalProperties: true } }), 401: R[401], 404: R[404] } },
  },
  '/policies/{id}/reinstatement': {
    post: { tags: ['Policies'], summary: 'Request reinstatement of a lapsed life policy (customer)', parameters: [pathParam('id', 'Policy id.')], requestBody: jsonBody({ type: 'object', required: ['goodHealthDeclaration'], properties: { goodHealthDeclaration: { type: 'boolean' }, healthChanges: { type: 'string' } } }), responses: { 201: jsonResp('Requested.', ref('Reinstatement')), 400: R[400], 401: R[401], 409: R[409] } },
  },
  '/policies/{id}/renew': {
    post: { tags: ['Policies'], summary: 'Start a renewal (health; returns the renewal application id)', parameters: [pathParam('id', 'Policy id.')], responses: { 201: jsonResp('Renewal application created.', { type: 'object', properties: { applicationId: { type: 'string' }, existing: { type: 'boolean' } } }), 200: jsonResp('Existing renewal in progress.', { type: 'object', properties: { applicationId: { type: 'string' }, existing: { type: 'boolean' } } }), 400: R[400], 401: R[401], 409: R[409] } },
  },

  // -------- Reinstatements --------
  '/reinstatements': {
    get: { tags: ['Reinstatements'], summary: 'List reinstatement requests (own for customers; all for underwriter/admin)', responses: { 200: jsonResp('Requests.', { type: 'array', items: ref('Reinstatement') }), 401: R[401], 403: R[403] } },
  },
  '/reinstatements/{id}/decision': {
    post: { tags: ['Reinstatements'], summary: 'Approve or decline a reinstatement (underwriter/admin)', parameters: [pathParam('id', 'Request id.')], requestBody: jsonBody({ type: 'object', required: ['approve'], properties: { approve: { type: 'boolean' }, reason: { type: 'string', description: 'Required when declining.' } } }), responses: { 200: jsonResp('Decided.', ref('Reinstatement')), 400: R[400], 401: R[401], 403: R[403], 404: R[404], 409: R[409] } },
  },

  // -------- Hospitals --------
  '/hospitals': {
    get: { tags: ['Hospitals'], summary: 'Search the hospital network', security: [], parameters: [queryParam('q', 'Name search.'), queryParam('city', 'City.'), queryParam('postalCode', 'Postal-code prefix.'), queryParam('specialty', 'Specialty.'), queryParam('network', 'network | non-network.', { type: 'string', enum: ['network', 'non-network'] }), queryParam('includeInactive', 'Include inactive hospitals.', { type: 'string', enum: ['true', 'false'] })], responses: { 200: jsonResp('Hospitals + disclaimer.', { type: 'object', properties: { disclaimer: { type: 'string' }, hospitals: { type: 'array', items: ref('Hospital') } } }) } },
    post: { tags: ['Hospitals'], summary: 'Add a hospital (admin)', requestBody: jsonBody(ref('Hospital')), responses: { 201: jsonResp('Created.', ref('Hospital')), 400: R[400], 401: R[401], 403: R[403] } },
  },
  '/hospitals/{id}': {
    get: { tags: ['Hospitals'], summary: 'Get a hospital', security: [], parameters: [pathParam('id', 'Hospital id.')], responses: { 200: jsonResp('Hospital.', ref('Hospital')), 404: R[404] } },
    put: { tags: ['Hospitals'], summary: 'Update a hospital (admin)', parameters: [pathParam('id', 'Hospital id.')], requestBody: jsonBody(ref('Hospital')), responses: { 200: jsonResp('Updated.', ref('Hospital')), 400: R[400], 401: R[401], 403: R[403], 404: R[404] } },
  },

  // -------- Health claims --------
  '/health-claims': {
    get: { tags: ['Health Claims'], summary: 'List health claims (own for customers; all for officers)', parameters: [queryParam('status', 'Filter by status.'), queryParam('type', 'cashless | reimbursement.'), queryParam('bucket', 'Named bucket filter.')], responses: { 200: jsonResp('Claims.', { type: 'array', items: ref('HealthClaimSummary') }), 401: R[401] } },
    post: { tags: ['Health Claims'], summary: 'File a health claim (customer)', requestBody: jsonBody({ type: 'object', required: ['policyId', 'memberId', 'type', 'admissionDate', 'dischargeDate', 'diagnosis', 'treatment', 'requestedAmount'], additionalProperties: true, properties: { policyId: { type: 'string' }, memberId: { type: 'string' }, type: { type: 'string', enum: ['cashless', 'reimbursement'] }, hospitalId: { type: 'string' }, hospitalName: { type: 'string' }, admissionDate: { type: 'string', format: 'date' }, dischargeDate: { type: 'string', format: 'date' }, diagnosis: { type: 'string' }, treatment: { type: 'string' }, isAccident: { type: 'boolean' }, requestedAmount: ref('Money'), payoutDetails: { type: 'object', additionalProperties: true, description: 'Required for reimbursement claims.' }, idempotencyKey: { type: 'string' } } }), responses: { 201: jsonResp('Filed.', ref('HealthClaim')), 400: R[400], 401: R[401], 403: R[403], 404: R[404], 409: R[409], 422: R[422] } },
  },
  '/health-claims/{id}': {
    get: { tags: ['Health Claims'], summary: 'Get a health claim', parameters: [pathParam('id', 'Claim id.')], responses: { 200: jsonResp('Claim.', ref('HealthClaim')), 401: R[401], 403: R[403], 404: R[404] } },
  },
  '/health-claims/{id}/request-documents': {
    post: { tags: ['Health Claims'], summary: 'Request documents (claims officer/admin)', parameters: [pathParam('id', 'Claim id.')], requestBody: jsonBody({ type: 'object', required: ['note'], properties: { note: { type: 'string' } } }), responses: { 200: jsonResp('Requested.', ref('HealthClaim')), 400: R[400], 401: R[401], 403: R[403], 409: R[409] } },
  },
  '/health-claims/{id}/respond': {
    post: { tags: ['Health Claims'], summary: 'Respond to a document request (customer)', parameters: [pathParam('id', 'Claim id.')], requestBody: jsonBody({ type: 'object', properties: { note: { type: 'string' } } }, false), responses: { 200: jsonResp('Resumed.', ref('HealthClaim')), 401: R[401], 409: R[409] } },
  },
  '/health-claims/{id}/notes': {
    post: { tags: ['Health Claims'], summary: 'Add an internal note (officer)', parameters: [pathParam('id', 'Claim id.')], requestBody: jsonBody({ type: 'object', required: ['note'], properties: { note: { type: 'string' } } }), responses: { 200: jsonResp('Noted.', ref('HealthClaim')), 400: R[400], 401: R[401], 403: R[403] } },
  },
  '/health-claims/{id}/preauth': {
    post: { tags: ['Health Claims'], summary: 'Pre-authorisation decision for a cashless claim: approve | reject (officer)', parameters: [pathParam('id', 'Claim id.')], requestBody: jsonBody({ type: 'object', required: ['decision'], properties: { decision: { type: 'string', enum: ['approve', 'reject'] }, amount: ref('Money'), reason: { type: 'string' } } }), responses: { 200: jsonResp('Decided.', ref('HealthClaim')), 400: R[400], 401: R[401], 403: R[403], 409: R[409], 422: R[422] } },
  },
  '/health-claims/{id}/final-bill': {
    post: { tags: ['Health Claims'], summary: 'Submit the final hospital bill (customer/officer)', parameters: [pathParam('id', 'Claim id.')], requestBody: jsonBody({ type: 'object', required: ['finalAmount'], properties: { finalAmount: ref('Money'), dischargeDate: { type: 'string', format: 'date' }, note: { type: 'string' } } }), responses: { 200: jsonResp('Submitted.', ref('HealthClaim')), 400: R[400], 401: R[401], 409: R[409] } },
  },
  '/health-claims/{id}/assess': {
    post: { tags: ['Health Claims'], summary: 'Assess a claim against policy terms (officer)', parameters: [pathParam('id', 'Claim id.')], requestBody: jsonBody({ type: 'object', properties: { billItems: { type: 'array', items: { type: 'object', properties: { description: { type: 'string' }, category: { type: 'string', enum: ['room', 'medical', 'surgery', 'pharmacy', 'diagnostics', 'non_medical'] }, amount: ref('Money'), admissible: { type: 'boolean' } } } } } }, false), responses: { 200: jsonResp('Assessed.', ref('HealthClaim')), 400: R[400], 401: R[401], 403: R[403], 409: R[409] } },
  },
  '/health-claims/{id}/verify-payout': {
    post: { tags: ['Health Claims'], summary: 'Verify reimbursement payout details (officer)', parameters: [pathParam('id', 'Claim id.')], requestBody: jsonBody({ type: 'object', properties: { payoutDetails: { type: 'object', additionalProperties: true } } }, false), responses: { 200: jsonResp('Verified.', ref('HealthClaim')), 400: R[400], 401: R[401], 403: R[403] } },
  },
  '/health-claims/{id}/approve': {
    post: { tags: ['Health Claims'], summary: 'Approve a claim (officer)', parameters: [pathParam('id', 'Claim id.')], responses: { 200: jsonResp('Approved.', ref('HealthClaim')), 401: R[401], 403: R[403], 409: R[409], 422: R[422] } },
  },
  '/health-claims/{id}/reject': {
    post: { tags: ['Health Claims'], summary: 'Reject a claim (officer)', parameters: [pathParam('id', 'Claim id.')], requestBody: jsonBody({ type: 'object', required: ['reason'], properties: { reason: { type: 'string' } } }), responses: { 200: jsonResp('Rejected.', ref('HealthClaim')), 400: R[400], 401: R[401], 403: R[403], 409: R[409] } },
  },

  // -------- Life claims (claimant portal) --------
  '/life-claims/portal/start': {
    post: { tags: ['Life Claims'], summary: 'Start claimant verification (public)', security: [], requestBody: jsonBody({ type: 'object', required: ['policyNumber', 'lifeAssuredName', 'lifeAssuredDob', 'claimant'], properties: { policyNumber: { type: 'string' }, lifeAssuredName: { type: 'string' }, lifeAssuredDob: { type: 'string', format: 'date' }, claimant: { type: 'object', additionalProperties: true, properties: { name: { type: 'string' }, relationship: { type: 'string' }, email: { type: 'string', format: 'email' }, phone: { type: 'string' }, idType: { type: 'string' }, idNumber: { type: 'string' } } } } }), responses: { 201: jsonResp('OTP sent.', { allOf: [ref('Challenge')], type: 'object' }), 400: R[400], 422: R[422] } },
  },
  '/life-claims/portal/verify': {
    post: { tags: ['Life Claims'], summary: 'Verify claimant OTP and open a claimant session (public)', security: [], requestBody: jsonBody({ type: 'object', required: ['accountId', 'otp'], properties: { accountId: { type: 'string' }, otp: { type: 'string' }, challengeId: { type: 'string' } } }), responses: { 200: jsonResp('Session opened.', { type: 'object', properties: { csrfToken: { type: 'string' }, user: ref('User') } }), 400: R[400] } },
  },
  '/life-claims/portal/me': {
    get: { tags: ['Life Claims'], summary: 'Claimant portal home (claimant)', responses: { 200: jsonResp('Claimant context.', { type: 'object', additionalProperties: true }), 401: R[401], 403: R[403] } },
  },
  '/life-claims': {
    get: { tags: ['Life Claims'], summary: 'List life claims (own for claimants; all for officers)', responses: { 200: jsonResp('Claims.', { type: 'array', items: ref('LifeClaimSummary') }), 401: R[401] } },
    post: { tags: ['Life Claims'], summary: 'Report a death claim (claimant)', requestBody: jsonBody({ type: 'object', required: ['dateOfDeath', 'causeOfDeath'], properties: { dateOfDeath: { type: 'string', format: 'date' }, causeOfDeath: { type: 'string' }, causeType: { type: 'string', enum: ['natural', 'accident', 'other'] }, placeOfDeath: { type: 'string' }, payoutDetails: { type: 'object', additionalProperties: true }, idempotencyKey: { type: 'string' } } }), responses: { 201: jsonResp('Reported.', ref('LifeClaim')), 400: R[400], 401: R[401], 403: R[403] } },
  },
  '/life-claims/{id}': {
    get: { tags: ['Life Claims'], summary: 'Get a life claim', parameters: [pathParam('id', 'Claim id.')], responses: { 200: jsonResp('Claim.', ref('LifeClaim')), 401: R[401], 403: R[403], 404: R[404] } },
  },
  '/life-claims/{id}/respond': {
    post: { tags: ['Life Claims'], summary: 'Respond to a document request (claimant)', parameters: [pathParam('id', 'Claim id.')], requestBody: jsonBody({ type: 'object', properties: { note: { type: 'string' } } }, false), responses: { 200: jsonResp('Resumed.', ref('LifeClaim')), 401: R[401], 409: R[409] } },
  },
  '/life-claims/{id}/start-review': {
    post: { tags: ['Life Claims'], summary: 'Start review (officer)', parameters: [pathParam('id', 'Claim id.')], responses: { 200: jsonResp('Under review.', ref('LifeClaim')), 401: R[401], 403: R[403], 409: R[409] } },
  },
  '/life-claims/{id}/request-documents': {
    post: { tags: ['Life Claims'], summary: 'Request documents (officer)', parameters: [pathParam('id', 'Claim id.')], requestBody: jsonBody({ type: 'object', required: ['note'], properties: { note: { type: 'string' } } }), responses: { 200: jsonResp('Requested.', ref('LifeClaim')), 400: R[400], 401: R[401], 403: R[403], 409: R[409] } },
  },
  '/life-claims/{id}/notes': {
    post: { tags: ['Life Claims'], summary: 'Add an internal note (officer)', parameters: [pathParam('id', 'Claim id.')], requestBody: jsonBody({ type: 'object', required: ['note'], properties: { note: { type: 'string' } } }), responses: { 200: jsonResp('Noted.', ref('LifeClaim')), 400: R[400], 401: R[401], 403: R[403] } },
  },
  '/life-claims/{id}/verify-claimant': {
    post: { tags: ['Life Claims'], summary: 'Verify the claimant identity (officer)', parameters: [pathParam('id', 'Claim id.')], requestBody: jsonBody({ type: 'object', properties: { note: { type: 'string' } } }, false), responses: { 200: jsonResp('Verified.', ref('LifeClaim')), 401: R[401], 403: R[403] } },
  },
  '/life-claims/{id}/clear-flag': {
    post: { tags: ['Life Claims'], summary: 'Clear the duplicate-claim flag (officer)', parameters: [pathParam('id', 'Claim id.')], requestBody: jsonBody({ type: 'object', required: ['note'], properties: { note: { type: 'string' } } }), responses: { 200: jsonResp('Cleared.', ref('LifeClaim')), 400: R[400], 401: R[401], 403: R[403] } },
  },
  '/life-claims/{id}/beneficiaries': {
    put: { tags: ['Life Claims'], summary: 'Set beneficiaries (officer)', parameters: [pathParam('id', 'Claim id.')], requestBody: jsonBody({ type: 'object', required: ['beneficiaries'], properties: { beneficiaries: { type: 'array', items: { type: 'object', additionalProperties: true, properties: { name: { type: 'string' }, relationship: { type: 'string' }, entitlement: { type: 'string' }, payoutDetails: { type: 'object', additionalProperties: true }, verified: { type: 'boolean' } } } } } }), responses: { 200: jsonResp('Set.', ref('LifeClaim')), 400: R[400], 401: R[401], 403: R[403], 409: R[409] } },
  },
  '/life-claims/{id}/assess': {
    post: { tags: ['Life Claims'], summary: 'First approval: assess the benefit and allocations (officer)', parameters: [pathParam('id', 'Claim id.')], requestBody: jsonBody({ type: 'object', required: ['approvedAmount', 'allocations'], properties: { approvedAmount: ref('Money'), allocations: { type: 'array', items: { type: 'object', properties: { beneficiaryId: { type: 'string' }, amount: ref('Money') } } }, note: { type: 'string' } } }), responses: { 200: jsonResp('Assessed.', ref('LifeClaim')), 400: R[400], 401: R[401], 403: R[403], 409: R[409] } },
  },
  '/life-claims/{id}/second-approval': {
    post: { tags: ['Life Claims'], summary: 'Independent second approval (a different officer)', parameters: [pathParam('id', 'Claim id.')], requestBody: jsonBody({ type: 'object', properties: { note: { type: 'string' } } }, false), responses: { 200: jsonResp('Approved.', ref('LifeClaim')), 401: R[401], 403: R[403], 409: R[409] } },
  },
  '/life-claims/{id}/send-back': {
    post: { tags: ['Life Claims'], summary: 'Return a claim to review from second approval (officer)', parameters: [pathParam('id', 'Claim id.')], requestBody: jsonBody({ type: 'object', required: ['reason'], properties: { reason: { type: 'string' } } }), responses: { 200: jsonResp('Returned.', ref('LifeClaim')), 400: R[400], 401: R[401], 403: R[403], 409: R[409] } },
  },
  '/life-claims/{id}/reject': {
    post: { tags: ['Life Claims'], summary: 'Reject a life claim (officer)', parameters: [pathParam('id', 'Claim id.')], requestBody: jsonBody({ type: 'object', required: ['reason'], properties: { reason: { type: 'string' } } }), responses: { 200: jsonResp('Rejected.', ref('LifeClaim')), 400: R[400], 401: R[401], 403: R[403], 409: R[409] } },
  },

  // -------- Payouts --------
  '/payouts/callback': {
    post: { tags: ['Payouts'], summary: 'Bank rail callback (simulated)', security: [], requestBody: jsonBody({ type: 'object', required: ['reference'], properties: { reference: { type: 'string' }, status: { type: 'string' } } }), responses: { 200: jsonResp('Processed.', { type: 'object', additionalProperties: true }), 400: R[400] } },
  },
  '/payouts': {
    get: { tags: ['Payouts'], summary: 'List payouts (claims officer/admin)', responses: { 200: jsonResp('Payouts.', { type: 'array', items: ref('Payout') }), 401: R[401], 403: R[403] } },
  },
  '/payouts/initiate': {
    post: { tags: ['Payouts'], summary: 'Initiate a payout (claims officer/admin)', requestBody: jsonBody({ type: 'object', additionalProperties: true, properties: { claimType: { type: 'string', enum: ['health', 'life'] }, claimId: { type: 'string' }, beneficiaryId: { type: 'string' } } }), responses: { 201: jsonResp('Initiated.', ref('Payout')), 401: R[401], 403: R[403] } },
  },
  '/payouts/{reference}/simulate': {
    post: { tags: ['Payouts'], summary: 'Drive the simulated bank rail (claims officer/admin)', parameters: [pathParam('reference', 'Payout reference.')], requestBody: jsonBody({ type: 'object', properties: { outcome: { type: 'string', enum: ['success', 'failed'] } } }, false), responses: { 200: jsonResp('Processed.', { type: 'object', additionalProperties: true }), 401: R[401], 403: R[403] } },
  },

  // -------- Documents --------
  '/documents': {
    get: { tags: ['Documents'], summary: 'List documents for an entity', parameters: [queryParam('entityType', 'application | policy | healthClaim | lifeClaim.'), queryParam('entityId', 'Entity id.')], responses: { 200: jsonResp('Documents.', { type: 'array', items: ref('Document') }), 401: R[401], 403: R[403] } },
    post: {
      tags: ['Documents'], summary: 'Upload a document (multipart; PDF/PNG/JPEG, max 5 MB)',
      requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', required: ['file', 'entityType', 'entityId'], properties: { file: { type: 'string', format: 'binary' }, entityType: { type: 'string', enum: ['application', 'policy', 'healthClaim', 'lifeClaim'] }, entityId: { type: 'string' }, category: { type: 'string' }, description: { type: 'string' } } } } } },
      responses: { 201: jsonResp('Uploaded.', ref('Document')), 400: R[400], 401: R[401], 403: R[403], 413: errorResponse('File too large (max 5 MB).') },
    },
  },
  '/documents/{id}/download': {
    get: { tags: ['Documents'], summary: 'Download a document (audited)', parameters: [pathParam('id', 'Document id.')], responses: { 200: { description: 'File stream.', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }, 400: R[400], 401: R[401], 403: R[403], 404: R[404] } },
  },

  // -------- Notifications --------
  '/notifications': {
    get: { tags: ['Notifications'], summary: 'List notifications with unread count', responses: { 200: jsonResp('Notifications.', { type: 'object', properties: { unread: { type: 'integer' }, notifications: { type: 'array', items: ref('Notification') } } }), 401: R[401] } },
  },
  '/notifications/read-all': {
    post: { tags: ['Notifications'], summary: 'Mark all notifications read', responses: { 200: jsonResp('Done.', ref('Ok')), 401: R[401] } },
  },
  '/notifications/{id}/read': {
    post: { tags: ['Notifications'], summary: 'Mark one notification read', parameters: [pathParam('id', 'Notification id.')], responses: { 200: jsonResp('Read.', ref('Notification')), 401: R[401], 404: R[404] } },
  },

  // -------- Family (VHC-M29) --------
  '/family': {
    get: { tags: ['Family'], summary: 'List your family members (customer)', responses: { 200: jsonResp('Family members.', { type: 'array', items: ref('FamilyMember') }), 401: R[401], 403: R[403] } },
    post: { tags: ['Family'], summary: 'Add a family member (customer)', requestBody: jsonBody({ type: 'object', required: ['fullName', 'dob', 'relationship'], properties: { fullName: { type: 'string' }, dob: { type: 'string', format: 'date' }, relationship: { type: 'string', enum: ['spouse', 'child', 'parent', 'sibling', 'parent-in-law', 'other'] }, gender: { type: 'string', enum: ['', 'female', 'male', 'other'] } } }), responses: { 201: jsonResp('Added.', ref('FamilyMember')), 401: R[401], 403: R[403], 422: R[422] } },
  },
  '/family/{id}': {
    put: { tags: ['Family'], summary: 'Update a family member (customer)', parameters: [pathParam('id', 'Family member id.')], requestBody: jsonBody({ type: 'object', required: ['fullName', 'dob', 'relationship'], properties: { fullName: { type: 'string' }, dob: { type: 'string', format: 'date' }, relationship: { type: 'string' }, gender: { type: 'string' } } }), responses: { 200: jsonResp('Updated.', ref('FamilyMember')), 401: R[401], 404: R[404], 422: R[422] } },
    delete: { tags: ['Family'], summary: 'Archive a family member (customer)', parameters: [pathParam('id', 'Family member id.')], responses: { 200: jsonResp('Archived.', ref('Ok')), 401: R[401], 404: R[404] } },
  },

  // -------- AI assistant --------
  '/ai/status': {
    get: { tags: ['AI Assistant'], summary: 'AI engine status', responses: { 200: jsonResp('Status.', { type: 'object', properties: { engine: { type: 'string', enum: ['claude', 'offline'] }, model: { type: 'string', nullable: true } } }), 401: R[401] } },
  },
  '/ai/ask': {
    post: { tags: ['AI Assistant'], summary: 'Ask the policy assistant a question (customer; throttled)', requestBody: jsonBody({ type: 'object', required: ['question'], properties: { question: { type: 'string', minLength: 2, maxLength: 4000 }, policyId: { type: 'string' }, history: { type: 'array', items: { type: 'object', additionalProperties: true } } } }), responses: { 200: jsonResp('Answer.', ref('AiAnswer')), 400: R[400], 401: R[401], 403: R[403], 429: R[429] } },
  },

  // -------- Admin --------
  '/admin/users': {
    get: { tags: ['Admin'], summary: 'List users (admin)', parameters: [queryParam('role', 'Filter by role.'), queryParam('q', 'Name/email search.')], responses: { 200: jsonResp('Users.', { type: 'array', items: ref('User') }), 401: R[401], 403: R[403] } },
    post: { tags: ['Admin'], summary: 'Invite a staff user (admin)', requestBody: jsonBody({ type: 'object', required: ['firstName', 'email', 'role'], properties: { firstName: { type: 'string' }, lastName: { type: 'string' }, email: { type: 'string', format: 'email' }, role: { type: 'string', enum: ['agent', 'underwriter', 'claims_officer', 'admin'] } } }), responses: { 201: jsonResp('Invited.', { type: 'object', properties: { user: ref('User') } }), 401: R[401], 403: R[403], 409: R[409], 422: R[422] } },
  },
  '/admin/users/{id}': {
    patch: { tags: ['Admin'], summary: 'Change a user role / active state (admin)', parameters: [pathParam('id', 'User id.')], requestBody: jsonBody({ type: 'object', properties: { role: { type: 'string' }, active: { type: 'boolean' } } }), responses: { 200: jsonResp('Updated.', ref('User')), 400: R[400], 401: R[401], 403: R[403], 404: R[404], 409: R[409] } },
  },
  '/admin/plans': {
    get: { tags: ['Admin'], summary: 'List all plans with version history (admin)', responses: { 200: jsonResp('Plans.', { type: 'array', items: ref('Plan') }), 401: R[401], 403: R[403] } },
    post: { tags: ['Admin'], summary: 'Create a plan (admin)', requestBody: jsonBody({ type: 'object', required: ['code', 'name', 'product', 'config'], properties: { code: { type: 'string' }, name: { type: 'string' }, product: { type: 'string', enum: ['health', 'life'] }, type: { type: 'string' }, description: { type: 'string' }, config: { type: 'object', additionalProperties: true } } }), responses: { 201: jsonResp('Created.', ref('Plan')), 400: R[400], 401: R[401], 403: R[403], 409: R[409] } },
  },
  '/admin/plans/{id}': {
    put: { tags: ['Admin'], summary: 'Update a plan (new version) (admin)', parameters: [pathParam('id', 'Plan id.')], requestBody: jsonBody({ type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, config: { type: 'object', additionalProperties: true }, changeNote: { type: 'string' } } }), responses: { 200: jsonResp('Updated.', ref('Plan')), 400: R[400], 401: R[401], 403: R[403], 404: R[404] } },
  },
  '/admin/plans/{id}/status': {
    patch: { tags: ['Admin'], summary: 'Activate/deactivate a plan (admin)', parameters: [pathParam('id', 'Plan id.')], requestBody: jsonBody({ type: 'object', properties: { active: { type: 'boolean' } } }), responses: { 200: jsonResp('Updated.', ref('Plan')), 401: R[401], 403: R[403], 404: R[404] } },
  },
  '/admin/notifications': {
    get: { tags: ['Admin'], summary: 'Recent notifications across users (admin)', responses: { 200: jsonResp('Notifications.', { type: 'array', items: ref('Notification') }), 401: R[401], 403: R[403] } },
  },
  '/admin/notifications/broadcast': {
    post: { tags: ['Admin'], summary: 'Broadcast a notice to a role (admin)', requestBody: jsonBody({ type: 'object', required: ['title', 'message'], properties: { role: { type: 'string', description: "'all' or a specific role." }, title: { type: 'string' }, message: { type: 'string' } } }), responses: { 200: jsonResp('Sent.', { type: 'object', properties: { sent: { type: 'integer' } } }), 400: R[400], 401: R[401], 403: R[403] } },
  },
  '/admin/audit-logs': {
    get: { tags: ['Admin'], summary: 'Query audit logs (admin)', parameters: [queryParam('action', 'Action substring.'), queryParam('entityType', 'Entity type.'), queryParam('entityId', 'Entity id.'), queryParam('actor', 'Actor name/role search.'), queryParam('limit', 'Max rows (default 300).', { type: 'integer' })], responses: { 200: jsonResp('Logs.', { type: 'array', items: { type: 'object', additionalProperties: true } }), 401: R[401], 403: R[403] } },
  },
  '/admin/exceptions': {
    get: { tags: ['Admin'], summary: 'List exception/retry queue (admin/claims officer)', parameters: [queryParam('status', 'open | resolved.')], responses: { 200: jsonResp('Exceptions.', { type: 'array', items: { type: 'object', additionalProperties: true } }), 401: R[401], 403: R[403] } },
  },
  '/admin/exceptions/{id}/retry': {
    post: { tags: ['Admin'], summary: 'Retry a failed autopay/payout exception (admin/claims officer)', parameters: [pathParam('id', 'Exception id.')], requestBody: jsonBody({ type: 'object', properties: { outcome: { type: 'string', enum: ['success', 'failed'] } } }, false), responses: { 200: jsonResp('Retried.', { type: 'object', additionalProperties: true }), 401: R[401], 403: R[403], 404: R[404], 409: R[409] } },
  },
  '/admin/exceptions/{id}/resolve': {
    post: { tags: ['Admin'], summary: 'Resolve an exception manually (admin/claims officer)', parameters: [pathParam('id', 'Exception id.')], requestBody: jsonBody({ type: 'object', required: ['note'], properties: { note: { type: 'string' } } }), responses: { 200: jsonResp('Resolved.', { type: 'object', additionalProperties: true }), 400: R[400], 401: R[401], 403: R[403], 404: R[404] } },
  },

  // -------- Reports --------
  '/reports/summary': {
    get: { tags: ['Reports'], summary: 'Operations summary: queues, status breakdowns, reconciliation (staff)', responses: { 200: jsonResp('Summary.', { type: 'object', additionalProperties: true }), 401: R[401], 403: R[403] } },
  },

  // -------- Dev (non-production only) --------
  '/dev/clock': {
    get: { tags: ['Dev'], summary: 'Read the test clock (non-production)', security: [], responses: { 200: jsonResp('Clock info.', { type: 'object', additionalProperties: true }) } },
    post: { tags: ['Dev'], summary: 'Advance/set/reset the test clock (admin, non-production)', requestBody: jsonBody({ type: 'object', properties: { advanceDays: { type: 'integer' }, setDate: { type: 'string', format: 'date' }, reset: { type: 'boolean' } } }, false), responses: { 200: jsonResp('Clock info + jobs run.', { type: 'object', additionalProperties: true }), 400: R[400], 401: R[401], 403: R[403] } },
  },
  '/dev/reset': {
    post: { tags: ['Dev'], summary: 'Reset and reseed the database (admin, non-production)', responses: { 200: jsonResp('Reset.', { type: 'object', additionalProperties: true }), 401: R[401], 403: R[403] } },
  },
  '/dev/autopay-outcome': {
    post: { tags: ['Dev'], summary: 'Set the simulated autopay outcome (admin, non-production)', requestBody: jsonBody({ type: 'object', required: ['outcome'], properties: { outcome: { type: 'string', enum: ['success', 'failure'] } } }), responses: { 200: jsonResp('Set.', { type: 'object', additionalProperties: true }), 400: R[400], 401: R[401], 403: R[403] } },
  },
  '/dev/run-jobs': {
    post: { tags: ['Dev'], summary: 'Run scheduled jobs now (admin, non-production)', responses: { 200: jsonResp('Jobs run.', { type: 'object', additionalProperties: true }), 401: R[401], 403: R[403] } },
  },
};

export const openapiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Vision Health Care API',
    version: '1.0.0',
    description:
      'REST API for Vision Health Care — health & life insurance: quoting, applications, underwriting, ' +
      'policy servicing, health and life claims, payments and payouts, documents, and admin tooling.\n\n' +
      `**Authentication.** ${bearerNote}\n\n` +
      '**Money.** All monetary amounts are integers in **paise** (1 INR = 100 paise).\n\n' +
      '**Roles.** `customer`, `claimant`, `agent`, `underwriter`, `claims_officer`, `admin`. ' +
      'Each operation summary notes the role(s) it is restricted to.',
  },
  servers: [{ url: '/api', description: 'Default (same origin).' }],
  tags: [
    { name: 'Meta', description: 'Health check and the spec itself.' },
    { name: 'Auth', description: 'Registration, verification, login, sessions and recovery.' },
    { name: 'Profile', description: 'Customer profile, address, contact changes and preferences.' },
    { name: 'Dashboard', description: 'Customer dashboard aggregates.' },
    { name: 'Plans', description: 'Insurance plan catalogue (public).' },
    { name: 'Quotes', description: 'Premium quoting (anonymous allowed).' },
    { name: 'Applications', description: 'Application lifecycle: draft → submit → review → underwriting → offer.' },
    { name: 'Payments', description: 'Premium/application payments and the simulated gateway.' },
    { name: 'Policies', description: 'Issued policies: servicing, nominees, renewal, reinstatement.' },
    { name: 'Reinstatements', description: 'Lapsed-policy reinstatement requests and decisions.' },
    { name: 'Hospitals', description: 'Network hospital directory.' },
    { name: 'Health Claims', description: 'Cashless and reimbursement health claims.' },
    { name: 'Life Claims', description: 'Death claims and the claimant portal.' },
    { name: 'Payouts', description: 'Claim payouts and the simulated bank rail.' },
    { name: 'Documents', description: 'Private, audited document storage.' },
    { name: 'Notifications', description: 'In-app notifications.' },
    { name: 'Family', description: 'Customer family roster.' },
    { name: 'AI Assistant', description: 'Policy assistant (Claude-backed).' },
    { name: 'Admin', description: 'User, plan, notification, audit and exception administration.' },
    { name: 'Reports', description: 'Operations reporting and reconciliation.' },
    { name: 'Dev', description: 'Development-only tooling (mounted only when NODE_ENV !== production).' },
  ],
  components: {
    securitySchemes: {
      cookieAuth: { type: 'apiKey', in: 'cookie', name: 'vhc_sid', description: 'Session cookie set on login.' },
      csrfToken: { type: 'apiKey', in: 'header', name: 'X-CSRF-Token', description: 'Required on POST/PUT/PATCH/DELETE.' },
    },
    schemas,
  },
  // Default: both the session cookie and the CSRF token. Public operations override with `security: []`.
  security: [{ cookieAuth: [], csrfToken: [] }],
  paths,
};

export default openapiSpec;
