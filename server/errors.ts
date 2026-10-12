export type ErrorCode =
  | "locked"
  | "not_started"
  | "cap_reached"
  | "unknown_idea"
  | "unknown_participant"
  | "name_taken"
  | "name_required"
  | "ideas_closed"
  | "idea_limit"
  | "invalid_idea"
  | "bad_state"
  | "bad_input"
  | "nothing_to_submit"
  | "unauthorized"
  | "not_configured"
  | "rate_limited";

export type VoteErrorCode = ErrorCode;

export class VoteError extends Error {
  constructor(public code: ErrorCode, message: string) {
    super(message);
  }
}

export const HTTP_STATUS: Record<ErrorCode, number> = {
  locked: 403,
  not_started: 403,
  cap_reached: 409,
  unknown_idea: 404,
  unknown_participant: 401,
  name_taken: 409,
  name_required: 400,
  ideas_closed: 403,
  idea_limit: 409,
  invalid_idea: 400,
  bad_state: 409,
  bad_input: 400,
  nothing_to_submit: 409,
  unauthorized: 401,
  not_configured: 503,
  rate_limited: 429,
};
