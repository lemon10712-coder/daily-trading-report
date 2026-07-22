#!/usr/bin/env python3
"""Generate stable morning and post-close PDF reports from repository JSON."""

from __future__ import annotations

import argparse
import html
import json
import os
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    KeepTogether,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
TAIPEI = ZoneInfo("Asia/Taipei")
PAGE_W, PAGE_H = A4
MARGIN = 15 * mm


def find_fonts() -> tuple[str, str, int]:
    candidates = [
        (r"C:\Windows\Fonts\msjh.ttc", r"C:\Windows\Fonts\msjhbd.ttc", 0),
        # WenQuanYi uses TrueType outlines; ReportLab can embed it on Ubuntu.
        ("/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc", 0),
        ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc", 0),
        ("/usr/share/fonts/opentype/noto/NotoSansCJKtc-Regular.otf", "/usr/share/fonts/opentype/noto/NotoSansCJKtc-Bold.otf", 0),
    ]
    for regular, bold, subfont in candidates:
        if Path(regular).exists() and Path(bold).exists():
            return regular, bold, subfont
    raise RuntimeError("No ReportLab-compatible Traditional Chinese font found.")


REGULAR_FONT, BOLD_FONT, SUBFONT = find_fonts()
pdfmetrics.registerFont(TTFont("CJ", REGULAR_FONT, subfontIndex=SUBFONT))
pdfmetrics.registerFont(TTFont("CJ-B", BOLD_FONT, subfontIndex=SUBFONT))

styles = getSampleStyleSheet()
styles.add(ParagraphStyle(name="TitleCJ", fontName="CJ-B", fontSize=20, leading=27, textColor=colors.HexColor("#253238"), alignment=TA_CENTER, spaceAfter=6))
styles.add(ParagraphStyle(name="SubCJ", fontName="CJ", fontSize=9, leading=13, textColor=colors.HexColor("#607077"), alignment=TA_CENTER, spaceAfter=10))
styles.add(ParagraphStyle(name="H1CJ", fontName="CJ-B", fontSize=14, leading=19, textColor=colors.HexColor("#8A4B2A"), spaceBefore=8, spaceAfter=6))
styles.add(ParagraphStyle(name="H2CJ", fontName="CJ-B", fontSize=10.5, leading=15, textColor=colors.HexColor("#33474F"), spaceBefore=4, spaceAfter=3))
styles.add(ParagraphStyle(name="BodyCJ", fontName="CJ", fontSize=8.8, leading=13.5, textColor=colors.HexColor("#263238"), spaceAfter=4))
styles.add(ParagraphStyle(name="SmallCJ", fontName="CJ", fontSize=7.3, leading=10.5, textColor=colors.HexColor("#53646A"), spaceAfter=2))
styles.add(ParagraphStyle(name="WarnCJ", fontName="CJ-B", fontSize=8.8, leading=13.5, textColor=colors.HexColor("#8B1E1E"), backColor=colors.HexColor("#FBEDEC"), borderPadding=7, spaceAfter=7))
styles.add(ParagraphStyle(name="GoodCJ", fontName="CJ-B", fontSize=8.8, leading=13.5, textColor=colors.HexColor("#285B42"), backColor=colors.HexColor("#EAF5EF"), borderPadding=7, spaceAfter=7))


def safe(value: object) -> str:
    text = str(value if value is not None else "")
    for symbol in ("⚪", "🎯", "✅", "❌", "⚠️", "⚠", "🟡", "🟠", "🔴", "🟢", "🚀", "🛡"):
        text = text.replace(symbol, "")
    return html.escape(text.strip(), quote=False).replace("\n", "<br/>")


def p(value: object, style: str = "BodyCJ") -> Paragraph:
    return Paragraph(safe(value), styles[style])


def read_json(path: Path, required: bool = True) -> dict:
    if not path.exists():
        if required:
            raise FileNotFoundError(path)
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def page_callback(report_date: str, edition: str):
    def draw(canvas, doc):
        canvas.saveState()
        canvas.setFillColor(colors.HexColor("#7A898E"))
        canvas.setFont("CJ", 7.3)
        canvas.drawString(MARGIN, 8 * mm, f"CHARLES AGENT｜{report_date}｜{edition}")
        canvas.drawRightString(PAGE_W - MARGIN, 8 * mm, f"第 {doc.page} 頁")
        canvas.restoreState()
    return draw


def styled_table(rows, widths, header=True):
    converted = [[p(cell, "SmallCJ") for cell in row] for row in rows]
    table = Table(converted, colWidths=widths, repeatRows=1 if header else 0)
    commands = [
        ("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#CED8DB")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("ROWBACKGROUNDS", (0, 1 if header else 0), (-1, -1), [colors.white, colors.HexColor("#F7F9F8")]),
    ]
    if header:
        commands.extend([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#425A63")),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), "CJ-B"),
        ])
    table.setStyle(TableStyle(commands))
    return table


def pick_rows(report: dict):
    rows = [["類型", "股票", "進場", "停利", "目標", "停損", "風險"]]
    summary = report.get("summary") or {}
    for label, key in [("安全牌", "safe_pick"), ("衝最快", "aggressive_pick")]:
        item = summary.get(key)
        if not item:
            continue
        rows.append([
            label,
            f"{item.get('name', '')} {item.get('symbol', '')}",
            item.get("entry", "--"),
            item.get("take_profit", "--"),
            item.get("target", "--"),
            item.get("stop_loss", "--"),
            item.get("risk_tag", ""),
        ])
    return rows


def build_story(report: dict, backtest: dict | None = None):
    report_date = report.get("date", "unknown")
    edition = "收盤回測版" if backtest and backtest.get("date") == report_date else "08:30 晨報版"
    story = [
        p(f"{report_date} 台股當沖日報", "TitleCJ"),
        p(f"{edition}｜報告產生時間 {report.get('generated_at', '--')}｜Asia/Taipei", "SubCJ"),
        p("本報告是條件式交易研究文件。未觸發進場條件即視為未交易；所有價位仍應以券商即時報價確認。", "WarnCJ"),
    ]

    summary = report.get("summary") or {}
    story.append(p("一、今日主策略", "H1CJ"))
    if summary:
        for label, key in [("安全牌", "safe_pick"), ("衝最快", "aggressive_pick")]:
            item = summary.get(key)
            if item:
                story.append(KeepTogether([
                    p(f"{label}｜{item.get('name', '')}（{item.get('symbol', '')}）", "H2CJ"),
                    p(item.get("reason", "")),
                ]))
        story.append(styled_table(pick_rows(report), [19*mm, 29*mm, 22*mm, 18*mm, 18*mm, 18*mm, 56*mm]))
    else:
        story.append(p("今天沒有通過風控的正式推薦；空手也是正式策略。", "GoodCJ"))

    story.append(p("二、候選排行與執行條件", "H1CJ"))
    candidates = report.get("candidates") or []
    rows = [["排行", "股票", "產業", "進場／停損", "計畫與風險"]]
    for item in candidates:
        rows.append([
            item.get("rank", ""),
            f"{item.get('name', '')}\n{item.get('symbol', '')}",
            item.get("category", ""),
            f"進 {item.get('entry', '--')}\n停損 {item.get('stop_loss', '--')}",
            f"{item.get('summary', '')}\nA：{item.get('plan_a', '')}\nB：{item.get('plan_b', '')}\n風險：{item.get('risk_tag', '')}",
        ])
    if len(rows) > 1:
        story.append(styled_table(rows, [13*mm, 27*mm, 26*mm, 30*mm, 84*mm]))
    else:
        story.append(p("沒有候選資料。"))

    story.extend([PageBreak(), p("三、重要新聞與延伸影響", "H1CJ")])
    for index, item in enumerate(report.get("news") or [], 1):
        story.append(KeepTogether([
            p(f"{index}. {item.get('category', '未分類')}｜{item.get('title', '')}", "H2CJ"),
            p(item.get("summary", "")),
        ]))

    warnings = (report.get("data_quality") or {}).get("warnings") or []
    story.append(p("四、資料品質與限制", "H1CJ"))
    if warnings:
        for warning in warnings:
            story.append(p(f"• {warning}", "SmallCJ"))
    else:
        story.append(p("本次沒有額外資料品質警告。", "GoodCJ"))

    if backtest and backtest.get("date") == report_date:
        story.extend([PageBreak(), p("五、收盤後精確回測", "H1CJ")])
        story.append(p(backtest.get("narrative", ""), "GoodCJ"))
        rows = [["類型", "股票", "結果", "進場", "平均出場", "毛報酬", "淨報酬"]]
        for label, key in [("安全牌", "safe_pick"), ("衝最快", "aggressive_pick")]:
            item = (backtest.get("picks") or {}).get(key)
            if not item:
                continue
            rows.append([
                label,
                f"{item.get('name', '')} {item.get('symbol', '')}",
                item.get("label", ""),
                f"{item.get('entry_price', '--')}\n{item.get('entry_time', '')}",
                f"{item.get('average_exit', '--')}\n{item.get('exit_time', '')}",
                f"{item.get('gross_pct', 0)}%",
                f"{item.get('net_pct', 0)}%",
            ])
        story.append(styled_table(rows, [18*mm, 30*mm, 38*mm, 24*mm, 26*mm, 21*mm, 21*mm]))
        story.append(p(f"方法：{backtest.get('methodology', '未提供')}。成本假設：{json.dumps(backtest.get('cost_assumptions', {}), ensure_ascii=False)}", "SmallCJ"))

        review = backtest.get("strategy_review") or {}
        story.extend([PageBreak(), p("六、推薦／選股／策略品質檢討", "H1CJ")])
        story.append(p(
            f"整體判定：{review.get('verdict', '尚未評分')}｜平均 {review.get('average_score', '--')} 分｜"
            f"評分 {review.get('reviewed_symbols', 0)} 檔｜正確 {review.get('correct_count', 0)} 檔｜"
            f"需要改善 {review.get('needs_improvement_count', 0)} 檔。",
            "GoodCJ" if review.get("average_score", 0) >= 55 else "WarnCJ",
        ))
        story.append(p(review.get("scoring_note", ""), "SmallCJ"))

        reviewed = []
        seen = set()
        for item in list((backtest.get("picks") or {}).values()) + list(backtest.get("candidates") or []):
            if not item or item.get("symbol") in seen:
                continue
            seen.add(item.get("symbol"))
            reviewed.append(item)
        quality_rows = [["股票", "分數／判定", "選股／方向", "進場／風控", "主要原因與改善"]]
        for item in reviewed:
            quality = item.get("quality_review") or {}
            reasons = "；".join(quality.get("reasons") or [])
            improvements = "；".join(quality.get("improvements") or [])
            quality_rows.append([
                f"{item.get('name', '')}\n{item.get('symbol', '')}",
                f"{quality.get('score', '--')}\n{quality.get('verdict', '--')}",
                f"選股：{quality.get('selection', '--')}\n方向：{quality.get('direction', '--')}",
                f"進場：{quality.get('entry', '--')}\n風控：{quality.get('risk', '--')}",
                f"原因：{reasons}\n改善：{improvements}",
            ])
        if len(quality_rows) > 1:
            story.append(styled_table(quality_rows, [27*mm, 25*mm, 31*mm, 36*mm, 61*mm]))

        priorities = review.get("priority_improvements") or []
        story.append(p("下次日報優先調整", "H2CJ"))
        if priorities:
            for index, item in enumerate(priorities, 1):
                story.append(p(f"{index}. {item.get('rule', '')}（影響 {item.get('affected_count', 0)} 檔）"))
        else:
            story.append(p("目前沒有足夠資料形成共通修正規則。"))

    story.extend([
        Spacer(1, 8),
        p("驗收聲明", "H1CJ"),
        p("只有資料日期、JSON驗證、PDF生成與逐頁渲染檢查全部通過，系統才可標記本日產出成功。", "GoodCJ"),
    ])
    return story, edition


def generate(report: dict, output_path: Path, backtest: dict | None = None):
    output_path.parent.mkdir(parents=True, exist_ok=True)
    story, edition = build_story(report, backtest)
    doc = BaseDocTemplate(
        str(output_path), pagesize=A4,
        leftMargin=MARGIN, rightMargin=MARGIN, topMargin=14*mm, bottomMargin=16*mm,
        title=f"{report.get('date', '')} CHARLES AGENT {edition}", author="CHARLES AGENT",
    )
    frame = Frame(MARGIN, 16*mm, PAGE_W - 2*MARGIN, PAGE_H - 31*mm, id="normal")
    doc.addPageTemplates([PageTemplate(id="main", frames=[frame], onPage=page_callback(report.get("date", ""), edition))])
    doc.build(story)
    if output_path.stat().st_size < 10_000:
        raise RuntimeError(f"Generated PDF is unexpectedly small: {output_path}")
    return edition


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--report", default=str(DATA / "latest.json"))
    parser.add_argument("--backtest", default=str(DATA / "backtest-latest.json"))
    parser.add_argument("--output-root", default=str(ROOT / "reports"))
    parser.add_argument("--mode", choices=["morning", "final", "auto", "both"], default="auto")
    args = parser.parse_args()

    report = read_json(Path(args.report))
    date = report.get("date")
    if not date:
        raise RuntimeError("Report JSON has no date")
    compact = date.replace("-", "")
    output_dir = Path(args.output_root) / f"{compact}日報"
    backtest = read_json(Path(args.backtest), required=False)
    has_backtest = backtest.get("date") == date and int(backtest.get("schema_version", 0)) >= 3 and bool(backtest.get("strategy_review"))
    generated = {}

    if args.mode in {"morning", "auto", "both"}:
        morning = output_dir / f"{compact}日報.pdf"
        generate(report, morning)
        generated["morning_pdf"] = morning.relative_to(ROOT).as_posix()
    if args.mode in {"final", "both"} or (args.mode == "auto" and has_backtest):
        if not has_backtest:
            raise RuntimeError("Final PDF requested but matching schema v3 strategy review is unavailable")
        final = output_dir / f"{compact}日報_含回測.pdf"
        generate(report, final, backtest)
        generated["final_pdf"] = final.relative_to(ROOT).as_posix()

    manifest_path = DATA / "pdf-latest.json"
    existing = read_json(manifest_path, required=False)
    if existing.get("date") == date:
        generated = {**existing, **generated}
    generated.update({"date": date, "generated_at": datetime.now(TAIPEI).isoformat(timespec="seconds")})
    manifest_path.write_text(json.dumps(generated, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(generated, ensure_ascii=False))


if __name__ == "__main__":
    main()
