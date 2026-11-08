import os
import uuid
from datetime import datetime, timedelta
from fastapi import FastAPI, Depends, HTTPException
from fastapi.responses import RedirectResponse, FileResponse
from fastapi.openapi.docs import get_swagger_ui_html
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session

from database import engine, Base, get_db
import models
import schemas
from oracle import AgenticVerificationOracle

# Oracle attestations are only honoured for a short window after they are issued.
ATTESTATION_TTL_MINUTES = 15
FEE_RATE = 0.005  # 0.50% non-markup income

def _adjust(db: Session, account_id: str, delta: float):
    """Atomic SQL-level balance change (UPDATE ... SET balance = balance + :delta), so concurrent
    requests cannot overwrite each other the way a read-modify-write in Python could."""
    db.query(models.Account).filter(models.Account.id == account_id).update(
        {models.Account.balance: models.Account.balance + delta}, synchronize_session=False)

# Initialize relational database tables
Base.metadata.create_all(bind=engine)

app = FastAPI(
    title="ABL Purpose-Bound Token Engine",
    description="Stateful Escrow & Conditional Settlement Core with Agentic Oracle",
    version="1.0.0",
    docs_url=None  # Disables default jsdelivr CDN to prevent ISP hangs in Pakistan
)

# ---------------------------------------------------------
# 1. CORS MIDDLEWARE (Allows web frontend communication)
# ---------------------------------------------------------
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,  # "*" origins and credentials cannot be combined safely; no cookies are used
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------
# 2. STATIC FILES & DEMO DASHBOARD ROUTING
# ---------------------------------------------------------
os.makedirs("static", exist_ok=True)
app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/demo", include_in_schema=False)
def serve_demo_dashboard():
    demo_file = os.path.join("static", "index.html")
    if not os.path.exists(demo_file):
        raise HTTPException(
            status_code=404,
            detail="Dashboard file static/index.html not found. Please create the static/index.html file."
        )
    return FileResponse(demo_file)

@app.get("/docs", include_in_schema=False)
async def custom_swagger_ui_html():
    return get_swagger_ui_html(
        openapi_url="/openapi.json",
        title="ABL Token Engine - API Docs",
        swagger_js_url="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.9.0/swagger-ui-bundle.js",
        swagger_css_url="https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.9.0/swagger-ui.css",
    )

@app.get("/", include_in_schema=False)
def root():
    return RedirectResponse(url="/demo")

# ---------------------------------------------------------
# 3. STARTUP DATA SEEDING (Bank Accounts Sandbox)
# ---------------------------------------------------------
def _seed(db: Session, number: str, title: str, balance: float, kind: str):
    if not db.query(models.Account).filter_by(account_number=number).first():
        db.add(models.Account(account_number=number, title=title, balance=balance, account_type=kind))

@app.on_event("startup")
def setup_seed_accounts():
    db = next(get_db())
    _seed(db, "ABL_ESCROW_GL", "ABL Central Escrow Pool", 0.0, "ABL_TRANSIT_ESCROW")
    _seed(db, "PKR_USER_001", "Sender Current Account", 50000.0, "CUSTOMER")
    _seed(db, "PKR_HOSPITAL_001", "Shaukat Khanum Hospital Account", 0.0, "CUSTOMER")
    _seed(db, "ABL_FEE_GL", "ABL Fee Income GL-4001", 0.0, "ABL_INCOME")  # receives the 0.50% fee
    db.commit()

# ---------------------------------------------------------
# 4. CORE ENGINE ENDPOINTS
# ---------------------------------------------------------

# Endpoint 1: Lock Deposit Funds into Stateful Token
@app.post("/api/tokens/lock", response_model=schemas.TokenResponse)
def lock_funds_into_token(req: schemas.LockTokenRequest, db: Session = Depends(get_db)):
    payer = db.query(models.Account).filter_by(account_number=req.payer_account_number).first()
    if not payer:
        raise HTTPException(status_code=404, detail="Payer account not found.")

    if req.amount <= 0:
        raise HTTPException(status_code=400, detail="Lock amount must be greater than zero.")

    if payer.balance < req.amount:
        raise HTTPException(status_code=400, detail="Insufficient funds in CASA account.")

    transit_escrow = db.query(models.Account).filter_by(account_number="ABL_ESCROW_GL").first()

    # Double-entry movement. The debit is conditional and atomic, so two simultaneous requests
    # cannot spend the same balance twice.
    debited = db.query(models.Account).filter(
        models.Account.id == payer.id, models.Account.balance >= req.amount
    ).update({models.Account.balance: models.Account.balance - req.amount}, synchronize_session=False)
    if debited != 1:
        db.rollback()
        raise HTTPException(status_code=400, detail="Insufficient funds in CASA account.")
    _adjust(db, transit_escrow.id, req.amount)

    token_id_str = f"TOK-ABL-{uuid.uuid4().hex[:8].upper()}"

    new_token = models.PurposeToken(
        token_identifier=token_id_str,
        payer_id=payer.id,
        amount=req.amount,
        purpose_code=req.purpose_code,
        state=models.TokenState.LOCKED
    )
    db.add(new_token)

    db.add(models.LedgerEntry(
        debit_account_id=payer.id,
        credit_account_id=transit_escrow.id,
        amount=req.amount,
        reference_id=token_id_str,
        description=f"Locked funds for {req.purpose_code}"
    ))

    db.commit()
    db.refresh(new_token)
    return new_token

# Endpoint 2: Agentic AI Oracle Audit
@app.post("/api/oracle/audit-invoice")
def audit_invoice(req: schemas.OracleAuditRequest, db: Session = Depends(get_db)):
    token = db.query(models.PurposeToken).filter_by(token_identifier=req.token_identifier).first()
    if not token:
        raise HTTPException(status_code=404, detail="Token not found.")

    if token.state != models.TokenState.LOCKED:
        raise HTTPException(status_code=400, detail=f"Token is in state '{token.state.value}', cannot be audited.")

    token_dict = {
        "token_identifier": token.token_identifier,
        "purpose_code": token.purpose_code,
        "amount": token.amount
    }

    is_valid, signature_or_reason, details = AgenticVerificationOracle.audit_invoice(req.dict(), token_dict)

    if not is_valid:
        raise HTTPException(status_code=422, detail={
            "error": "AUDIT_REJECTED",
            "reason": signature_or_reason,
            "logs": details.get("logs", [])
        })

    return {
        "audit_status": "PASSED",
        "message": "Invoice successfully verified by Agentic AI Oracle.",
        "attestation": details["attestation"],
        "signature": details["signature"],
        "agent_audit_logs": details["logs"]
    }

# Endpoint 3: Cryptographically Verified Settlement
@app.post("/api/tokens/settle")
def settle_token(req: schemas.VerifiedSettlementRequest, db: Session = Depends(get_db)):
    token = db.query(models.PurposeToken).filter_by(token_identifier=req.token_identifier).first()
    if not token:
        raise HTTPException(status_code=404, detail="Purpose token not found.")

    if token.state != models.TokenState.LOCKED:
        raise HTTPException(status_code=400, detail=f"Cannot settle token in state: {token.state.value}")

    att = req.attestation

    # 1) Was this proof really issued by our oracle?
    if not AgenticVerificationOracle.verify_signature(att, req.signature):
        raise HTTPException(status_code=401, detail="SECURITY_ALERT: Cryptographic signature mismatch. Untrusted Oracle proof.")

    # 2) Is the (valid) proof bound to THIS settlement? Without these checks a signature issued for
    #    one token or beneficiary could be replayed against another.
    if str(att.get("token_identifier")) != token.token_identifier:
        raise HTTPException(status_code=401, detail="SECURITY_ALERT: Attestation was issued for a different token.")
    if str(att.get("beneficiary_account")) != req.beneficiary_account_number:
        raise HTTPException(status_code=401, detail="SECURITY_ALERT: Attestation beneficiary does not match the settlement beneficiary.")
    if att.get("status") != "APPROVED":
        raise HTTPException(status_code=401, detail="SECURITY_ALERT: Attestation is not in APPROVED status.")
    try:
        issued_at = datetime.fromisoformat(str(att["timestamp"]))
    except (KeyError, ValueError):
        raise HTTPException(status_code=401, detail="SECURITY_ALERT: Attestation timestamp is missing or malformed.")
    if datetime.utcnow() - issued_at > timedelta(minutes=ATTESTATION_TTL_MINUTES):
        raise HTTPException(status_code=401, detail="Attestation expired. Re-run the oracle audit.")

    beneficiary = db.query(models.Account).filter_by(account_number=req.beneficiary_account_number).first()
    if not beneficiary:
        raise HTTPException(status_code=404, detail="Beneficiary account not found.")

    transit_escrow = db.query(models.Account).filter_by(account_number="ABL_ESCROW_GL").first()
    payer = db.query(models.Account).filter_by(id=token.payer_id).first()
    fee_gl = db.query(models.Account).filter_by(account_number="ABL_FEE_GL").first()
    if not fee_gl:
        fee_gl = models.Account(account_number="ABL_FEE_GL", title="ABL Fee Income GL-4001", balance=0.0, account_type="ABL_INCOME")
        db.add(fee_gl)
        db.flush()

    settle_amount = round(float(att["approved_amount"]), 2)
    if settle_amount <= 0 or settle_amount > token.amount + 0.005:
        raise HTTPException(status_code=400, detail="Approved amount is outside the locked token capacity.")

    abl_fee = round(settle_amount * FEE_RATE, 2)          # 0.5% Bank Non-Markup Income
    merchant_amount = round(settle_amount - abl_fee, 2)
    refund = round(token.amount - settle_amount, 2)       # any unclaimed remainder goes back to the payer

    # Every rupee leaving escrow lands somewhere: merchant + fee + (optional) refund == token.amount
    # Claim the token atomically (LOCKED -> SETTLED). If two requests race, exactly one wins.
    claimed = db.query(models.PurposeToken).filter(
        models.PurposeToken.id == token.id, models.PurposeToken.state == models.TokenState.LOCKED
    ).update({models.PurposeToken.state: models.TokenState.SETTLED}, synchronize_session=False)
    if claimed != 1:
        db.rollback()
        raise HTTPException(status_code=409, detail="Token was already settled by another request.")

    _adjust(db, transit_escrow.id, -token.amount)
    _adjust(db, beneficiary.id, merchant_amount)
    _adjust(db, fee_gl.id, abl_fee)
    if refund > 0:
        _adjust(db, payer.id, refund)
    token.state = models.TokenState.SETTLED

    db.add(models.LedgerEntry(
        debit_account_id=transit_escrow.id, credit_account_id=beneficiary.id, amount=merchant_amount,
        reference_id=token.token_identifier,
        description=f"Cryptographically settled {token.purpose_code} to merchant"))
    db.add(models.LedgerEntry(
        debit_account_id=transit_escrow.id, credit_account_id=fee_gl.id, amount=abl_fee,
        reference_id=token.token_identifier, description="0.50% non-markup fee captured"))
    if refund > 0:
        db.add(models.LedgerEntry(
            debit_account_id=transit_escrow.id, credit_account_id=payer.id, amount=refund,
            reference_id=token.token_identifier, description="Unclaimed token remainder returned to payer"))

    db.commit()

    return {
        "status": "SUCCESS",
        "message": "Funds settled successfully into merchant account via verified Oracle signature.",
        "token_identifier": token.token_identifier,
        "token_state": token.state.value,
        "settled_amount": merchant_amount,
        "bank_fee_captured": abl_fee,
        "refunded_amount": max(refund, 0.0),
        "merchant_new_balance": beneficiary.balance
    }

# Endpoint 4: Ledger Balance Monitor
@app.get("/api/accounts/overview")
def get_accounts_overview(db: Session = Depends(get_db)):
    accounts = db.query(models.Account).all()
    return [{"account": a.account_number, "title": a.title, "balance": a.balance} for a in accounts]
