from setuptools import setup

setup(
    name="sheets-banco",
    version="1.0.0",
    description="Python SDK for sheets.banco — turn Google Sheets into REST APIs",
    py_modules=["sheets_banco"],
    python_requires=">=3.8",
    install_requires=[],
    extras_require={
        "httpx": ["httpx>=0.24"],
    },
)
