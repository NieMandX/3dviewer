from __future__ import annotations

from datetime import date
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / 'docs' / 'market'
FONT_REGULAR = '/System/Library/Fonts/Supplemental/Arial.ttf'
FONT_BOLD = '/System/Library/Fonts/Supplemental/Arial Bold.ttf'
GEN_DATE = date.today().strftime('%d.%m.%Y')

LANDSCAPE_TITLE = 'Конкурентный ландшафт LPMVIEW'
TABLE_TITLE = 'Жесткая продуктовая таблица LPMVIEW'

LANDSCAPE_SECTIONS = [
    {
        'title': 'Кто конкуренты',
        'rows': [
            ('Revizto', 'Сильный coordination-инструмент для 2D/3D, issues и clash workflows.'),
            ('Autodesk BIM Collaborate Pro', 'Сильный enterprise-контур для model coordination, clash detection и governance.'),
            ('Trimble Connect', 'Сильный web collaboration viewer с хорошими интеграциями в экосистему Trimble/Tekla/SketchUp.'),
            ('Dalux BIM Viewer', 'Сильный массовый BIM/web/mobile viewer с низким порогом входа.'),
            ('Adobe Substance 3D Reviewer', 'Близок по линии web + VR collaborative review, особенно для design/product review.'),
            ('ShapesXR', 'Сильный XR-native multiuser collaboration продукт.'),
            ('Sketchfab Enterprise', 'Сильный web 3D sharing и asset collaboration слой.'),
        ],
    },
    {
        'title': 'В чем они сильнее',
        'rows': [
            ('Revizto', 'Зрелость coordination workflow, issue management, корпоративная внедряемость.'),
            ('Autodesk BIM Collaborate Pro', 'Глубокая интеграция с Autodesk ecosystem, governance, clash pipelines, роли.'),
            ('Trimble Connect', 'Интеграции и межпродуктовая связка с инженерными и строительными инструментами.'),
            ('Dalux BIM Viewer', 'Простота, мобильность, быстрая адаптация пользователями на стройке и в проектах.'),
            ('Adobe Substance 3D Reviewer', 'Полированный VR review UX, true-scale review, заметный фокус на immersive feedback.'),
            ('ShapesXR', 'Качественная XR co-presence и native immersive collaboration UX.'),
            ('Sketchfab Enterprise', 'Простая публикация и распространение 3D-ассетов в вебе.'),
        ],
    },
]

UNIQUENESS_BULLETS = [
    'Одна review-комната вместо разрозненной связки viewer + Zoom/Telegram + таблицы замечаний.',
    'Web, desktop, mobile и Quest VR в одном пользовательском сценарии.',
    'Контекст привязан к сцене: камера, аннотация, модель, объект, room, история обсуждения.',
    'Будущий voice layer с отдельным аудиотреком на участника, transcript по людям и AI summary встречи.',
    'Возможность развивать HPM/LPM/UCX-aware workflows и model QA прямо внутри review-сессии.',
    'Российский контур размещения на Yandex Cloud как отдельный аргумент для части рынка.',
]

POSITIONING_BLOCKS = [
    ('Ключевое позиционирование', 'Не просто viewer, а слой принятия решений поверх 3D-сцены.'),
    ('Продуктовая формула', 'Платформа совместного review 3D-моделей с VR, голосом и AI-протоколом встречи.'),
    ('Основной value proposition', 'Открыть модель в браузере или VR, обсудить ее голосом, оставить замечания в сцене и получить структурированный итог встречи.'),
    ('Первый beachhead сегмент', 'Архитектурная визуализация, VDC/BIM review, девелоперские и студийные команды, которым нужен быстрый review без тяжелого enterprise-комбайна.'),
]

PRODUCT_ROWS = [
    {
        'competitor': 'Revizto',
        'weakness': 'Тяжелее как entry-point, сильнее про coordination platform, слабее как легкая web/VR review-комната с зафиксированным итогом живой встречи.',
        'win': 'Наш продукт должен давать мгновенный вход в review room из браузера, VR-режим, голосовое обсуждение, transcript по участникам и AI-протокол решений без тяжелой enterprise-обвязки.',
    },
    {
        'competitor': 'Autodesk BIM Collaborate Pro',
        'weakness': 'Высокий порог внедрения, зависимость от Autodesk ecosystem, акцент на governance и BIM pipeline, а не на быструю живую review-сессию.',
        'win': 'Нужно выигрывать скоростью запуска сессии, vendor-neutral работой с моделями, простым room-based collaboration и фокусом на review outcome, а не на тяжёлый BIM governance слой.',
    },
    {
        'competitor': 'Trimble Connect',
        'weakness': 'Сильный viewer и integrations hub, но неочевидное преимущество в immersive review + voice transcript + AI summary.',
        'win': 'Наш продукт должен делать ставку на immersive review room, синхронное обсуждение сцены и автоматическое извлечение решений, тем и action items.',
    },
    {
        'competitor': 'Dalux BIM Viewer',
        'weakness': 'Сильный массовый viewer, но слабее как advanced review platform с VR и интеллектуальной обработкой встречи.',
        'win': 'Нужно давать более глубокий review workflow: voice room, transcript, AI summary, привязка замечаний к сцене и более богатый technical review UX.',
    },
    {
        'competitor': 'Adobe Substance 3D Reviewer',
        'weakness': 'Очень силен в immersive design review, но неочевидно заточен под техническую coordination-задачу, traceability решений и HPM/LPM/UCX-aware workflows.',
        'win': 'Нужно выигрывать технической направленностью: review сложных production/engineering моделей, scene-bound comments, контроль решений и workflow для тяжелых сцен.',
    },
    {
        'competitor': 'ShapesXR',
        'weakness': 'Силен в XR co-presence, но слабее как инструмент для структурированного review сложных моделей и технической фиксации результата.',
        'win': 'Наш продукт должен совмещать XR-присутствие с web-first доступом, model review, аннотациями, журналом решений и AI-обработкой обсуждения.',
    },
    {
        'competitor': 'Sketchfab Enterprise',
        'weakness': 'Сильнее как платформа публикации и шаринга 3D-ассетов, но заметно слабее как полноценная collaborative review-среда.',
        'win': 'Нужно позиционироваться не как asset hosting, а как collaborative decision room: обсуждение, фиксация замечаний, стенограмма и итог встречи.',
    },
]

SOURCES = [
    ('Revizto', 'https://revizto.com/product/integrated-issue-management'),
    ('Autodesk BIM Collaborate Pro', 'https://www.autodesk.com/products/bim-collaborate/features'),
    ('Trimble Connect', 'https://www.trimble.com/en/products/trimble-connect/real-time-collaboration-software'),
    ('Dalux BIM Viewer', 'https://www.dalux.com/products/bim-viewer/'),
    ('Adobe Substance 3D Reviewer', 'https://helpx.adobe.com/substance-3d-reviewer.html'),
    ('Adobe Reviewer announcement', 'https://blog.adobe.com/en/publish/2025/08/14/new-substance-3d-reviewer-from-adobe-meta-reimagines-design-reviews'),
    ('ShapesXR Collaboration', 'https://learn.shapesxr.com/collaboration'),
    ('Sketchfab Enterprise', 'https://sketchfab.com/enterprise'),
]


def register_fonts() -> None:
    pdfmetrics.registerFont(TTFont('ArialLocal', FONT_REGULAR))
    pdfmetrics.registerFont(TTFont('ArialLocalBold', FONT_BOLD))


styles = getSampleStyleSheet()
BASE = ParagraphStyle(
    'Base',
    parent=styles['Normal'],
    fontName='ArialLocal',
    fontSize=10.5,
    leading=14,
    textColor=colors.HexColor('#142033'),
    spaceAfter=0,
)
TITLE = ParagraphStyle(
    'TitleRu',
    parent=BASE,
    fontName='ArialLocalBold',
    fontSize=20,
    leading=24,
    alignment=TA_CENTER,
    textColor=colors.HexColor('#0d1b2a'),
    spaceAfter=10,
)
SUBTITLE = ParagraphStyle(
    'SubtitleRu',
    parent=BASE,
    fontSize=10,
    leading=13,
    alignment=TA_CENTER,
    textColor=colors.HexColor('#5c677d'),
)
H1 = ParagraphStyle(
    'H1Ru',
    parent=BASE,
    fontName='ArialLocalBold',
    fontSize=14,
    leading=18,
    textColor=colors.HexColor('#1d3557'),
    spaceBefore=8,
    spaceAfter=6,
)
H2 = ParagraphStyle(
    'H2Ru',
    parent=BASE,
    fontName='ArialLocalBold',
    fontSize=11.5,
    leading=15,
    textColor=colors.HexColor('#1d3557'),
)
BODY = ParagraphStyle(
    'BodyRu',
    parent=BASE,
)
BULLET = ParagraphStyle(
    'BulletRu',
    parent=BASE,
    leftIndent=14,
    firstLineIndent=-10,
)
SMALL = ParagraphStyle(
    'SmallRu',
    parent=BASE,
    fontSize=9,
    leading=12,
    textColor=colors.HexColor('#45556f'),
)
TABLE_HEADER = ParagraphStyle(
    'TableHeader',
    parent=BASE,
    fontName='ArialLocalBold',
    fontSize=9.5,
    leading=12,
    textColor=colors.white,
    alignment=TA_LEFT,
)
TABLE_CELL = ParagraphStyle(
    'TableCell',
    parent=BASE,
    fontSize=8.8,
    leading=11.2,
)


def p(text: str, style: ParagraphStyle = BODY) -> Paragraph:
    return Paragraph(text.replace('\n', '<br/>'), style)


def build_header(story: list, title: str, subtitle: str) -> None:
    story.append(Spacer(1, 8 * mm))
    story.append(p(title, TITLE))
    story.append(p(subtitle, SUBTITLE))
    story.append(Spacer(1, 7 * mm))


def build_rows_table(rows: list[tuple[str, str]], widths: list[float]) -> Table:
    data = [[p('Продукт', TABLE_HEADER), p('Суть', TABLE_HEADER)]]
    for left, right in rows:
        data.append([p(left, H2), p(right, TABLE_CELL)])
    table = Table(data, colWidths=widths, repeatRows=1)
    table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#1d3557')),
        ('BOX', (0, 0), (-1, -1), 0.5, colors.HexColor('#9fb2c6')),
        ('INNERGRID', (0, 0), (-1, -1), 0.35, colors.HexColor('#d0d7e2')),
        ('BACKGROUND', (0, 1), (-1, -1), colors.HexColor('#f8fafc')),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.HexColor('#f8fafc'), colors.HexColor('#eef3f8')]),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING', (0, 0), (-1, -1), 7),
        ('RIGHTPADDING', (0, 0), (-1, -1), 7),
        ('TOPPADDING', (0, 0), (-1, -1), 6),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
    ]))
    return table


def build_product_table() -> Table:
    data = [[
        p('Конкурент', TABLE_HEADER),
        p('Слабое место конкурента', TABLE_HEADER),
        p('Что должен делать наш продукт, чтобы выигрывать', TABLE_HEADER),
    ]]
    for row in PRODUCT_ROWS:
        data.append([
            p(row['competitor'], H2),
            p(row['weakness'], TABLE_CELL),
            p(row['win'], TABLE_CELL),
        ])
    table = Table(data, colWidths=[42 * mm, 63 * mm, 78 * mm], repeatRows=1)
    table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#0f4c5c')),
        ('BOX', (0, 0), (-1, -1), 0.5, colors.HexColor('#8aa3ad')),
        ('INNERGRID', (0, 0), (-1, -1), 0.35, colors.HexColor('#c7d3d8')),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.HexColor('#f7fbfc'), colors.HexColor('#edf5f7')]),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
        ('RIGHTPADDING', (0, 0), (-1, -1), 6),
        ('TOPPADDING', (0, 0), (-1, -1), 6),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
    ]))
    return table


def add_page_number(canvas, doc) -> None:
    canvas.setFont('ArialLocal', 8)
    canvas.setFillColor(colors.HexColor('#6b7280'))
    canvas.drawRightString(doc.pagesize[0] - 18 * mm, 10 * mm, f'Стр. {doc.page}')


def build_landscape_pdf(path: Path) -> None:
    doc = SimpleDocTemplate(
        str(path),
        pagesize=A4,
        leftMargin=16 * mm,
        rightMargin=16 * mm,
        topMargin=14 * mm,
        bottomMargin=16 * mm,
        title=LANDSCAPE_TITLE,
        author='Codex',
        subject='Конкурентный ландшафт и позиционирование LPMVIEW',
    )
    story = []
    build_header(story, LANDSCAPE_TITLE, f'Подготовлено: {GEN_DATE}')
    story.append(p('Документ фиксирует текущее конкурентное поле, сильные стороны ближайших аналогов, будущую уникальность продукта и рекомендуемое рыночное позиционирование.', BODY))
    story.append(Spacer(1, 5 * mm))

    for section in LANDSCAPE_SECTIONS:
        story.append(p(section['title'], H1))
        story.append(build_rows_table(section['rows'], [52 * mm, 118 * mm]))
        story.append(Spacer(1, 5 * mm))

    story.append(p('В чем будущая уникальность продукта', H1))
    for item in UNIQUENESS_BULLETS:
        story.append(p(f'• {item}', BULLET))
    story.append(Spacer(1, 5 * mm))

    story.append(p('Как позиционировать продукт на рынке', H1))
    pos_rows = [(title, text) for title, text in POSITIONING_BLOCKS]
    story.append(build_rows_table(pos_rows, [52 * mm, 118 * mm]))
    story.append(Spacer(1, 5 * mm))

    story.append(p('Короткий вывод', H1))
    story.append(p('LPMVIEW стоит позиционировать не как еще один viewer и не как облегченный BIM-комбайн, а как collaborative decision room для review сложных 3D-моделей. Ключевой акцент должен быть на том, что команда не просто смотрит сцену, а принимает решения, фиксирует замечания, обсуждает их голосом и получает структурированный итог встречи.', BODY))

    story.append(PageBreak())
    story.append(p('Источники', H1))
    for name, url in SOURCES:
        story.append(p(f'• {name}: {url}', SMALL))

    doc.build(story, onFirstPage=add_page_number, onLaterPages=add_page_number)


def build_product_pdf(path: Path) -> None:
    doc = SimpleDocTemplate(
        str(path),
        pagesize=A4,
        leftMargin=14 * mm,
        rightMargin=14 * mm,
        topMargin=14 * mm,
        bottomMargin=16 * mm,
        title=TABLE_TITLE,
        author='Codex',
        subject='Сравнительная продуктовая таблица LPMVIEW против конкурентов',
    )
    story = []
    build_header(story, TABLE_TITLE, f'Подготовлено: {GEN_DATE}')
    story.append(p('Таблица сформулирована жестко: для каждого ближайшего конкурента указан рабочий продуктовый разрыв и конкретное требование к LPMVIEW, которое дает шанс выигрывать на рынке.', BODY))
    story.append(Spacer(1, 5 * mm))
    story.append(build_product_table())
    story.append(Spacer(1, 5 * mm))
    story.append(p('Принцип чтения таблицы', H1))
    story.append(p('Колонка справа не описывает абстрактные пожелания. Это список того, что продукт должен реально уметь и демонстрировать пользователю, чтобы сравнение с конкурентом было в нашу пользу.', BODY))
    story.append(Spacer(1, 5 * mm))
    story.append(p('Источники', H1))
    for name, url in SOURCES:
        story.append(p(f'• {name}: {url}', SMALL))
    doc.build(story, onFirstPage=add_page_number, onLaterPages=add_page_number)


def write_landscape_md(path: Path) -> None:
    lines = [
        f'# {LANDSCAPE_TITLE}',
        '',
        f'Подготовлено: {GEN_DATE}',
        '',
        'Документ фиксирует текущее конкурентное поле, сильные стороны ближайших аналогов, будущую уникальность продукта и рекомендуемое рыночное позиционирование.',
        '',
    ]
    for section in LANDSCAPE_SECTIONS:
        lines.extend([f'## {section["title"]}', ''])
        for left, right in section['rows']:
            lines.append(f'- **{left}**: {right}')
        lines.append('')
    lines.extend(['## В чем будущая уникальность продукта', ''])
    for item in UNIQUENESS_BULLETS:
        lines.append(f'- {item}')
    lines.append('')
    lines.extend(['## Как позиционировать продукт на рынке', ''])
    for title, text in POSITIONING_BLOCKS:
        lines.append(f'- **{title}**: {text}')
    lines.extend(['', '## Короткий вывод', '', 'LPMVIEW стоит позиционировать не как еще один viewer и не как облегченный BIM-комбайн, а как collaborative decision room для review сложных 3D-моделей. Ключевой акцент должен быть на том, что команда не просто смотрит сцену, а принимает решения, фиксирует замечания, обсуждает их голосом и получает структурированный итог встречи.', '', '## Источники', ''])
    for name, url in SOURCES:
        lines.append(f'- {name}: {url}')
    path.write_text('\n'.join(lines) + '\n')


def write_product_md(path: Path) -> None:
    lines = [
        f'# {TABLE_TITLE}',
        '',
        f'Подготовлено: {GEN_DATE}',
        '',
        '| Конкурент | Слабое место конкурента | Что должен делать наш продукт, чтобы выигрывать |',
        '| --- | --- | --- |',
    ]
    for row in PRODUCT_ROWS:
        lines.append(
            f'| {row["competitor"]} | {row["weakness"]} | {row["win"]} |'
        )
    lines.extend(['', '## Источники', ''])
    for name, url in SOURCES:
        lines.append(f'- {name}: {url}')
    path.write_text('\n'.join(lines) + '\n')


def main() -> None:
    register_fonts()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    write_landscape_md(OUT_DIR / 'competitive-landscape-lpmview.md')
    write_product_md(OUT_DIR / 'product-competition-table-lpmview.md')
    build_landscape_pdf(OUT_DIR / 'competitive-landscape-lpmview.pdf')
    build_product_pdf(OUT_DIR / 'product-competition-table-lpmview.pdf')
    print('Generated:')
    print(OUT_DIR / 'competitive-landscape-lpmview.md')
    print(OUT_DIR / 'competitive-landscape-lpmview.pdf')
    print(OUT_DIR / 'product-competition-table-lpmview.md')
    print(OUT_DIR / 'product-competition-table-lpmview.pdf')


if __name__ == '__main__':
    main()
