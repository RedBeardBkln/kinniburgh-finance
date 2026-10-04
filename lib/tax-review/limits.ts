// Constants shared by the gate (server) and the Final review components (browser). A file of its own with NO imports, so a client
// component can use them without pulling the gate (and with it node:crypto) into the browser bundle. PURE.

/** A reason written with an acceptance or a withdrawal: 3 to 500 characters. */
export const REASON_MIN = 3;
export const REASON_MAX = 500;

/** The phrase the owner types to approve (together with his full name). */
export const TYPED_PHRASE = "I PREPARED THIS RETURN";
