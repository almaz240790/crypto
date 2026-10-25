from app.admin_rules import can_decide, transition_allowed


def test_transitions() -> None:
    assert transition_allowed("forward", "live")
    assert transition_allowed("live", "forward")
    assert not transition_allowed("backtest", "live")  # в live только через форвард
    assert not transition_allowed("archived", "live")


def test_four_eyes() -> None:
    assert can_decide(1, 2, "admin", None) == (True, "")
    ok, why = can_decide(1, 1, "admin", "very long reason given here, 20+")
    assert not ok and "другой админ" in why
    assert not can_decide(1, 1, "owner", "коротко")[0]
    assert can_decide(
        1, 1, "owner", "в команде один админ, подтверждаю сам после форварда 3 мес"
    ) == (True, "owner-override")
