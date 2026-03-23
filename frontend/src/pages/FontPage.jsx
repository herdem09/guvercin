import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import './FontPage.css'

const FALLBACK_FONTS = [
    'Arial', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Times New Roman',
    'Georgia', 'Garamond', 'Courier New', 'Comic Sans MS', 'Impact',
]

function FontPage() {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const [fonts, setFonts] = useState(FALLBACK_FONTS)
    const [selectedFont, setSelectedFont] = useState(
        () => localStorage.getItem('temp_font') || localStorage.getItem('font') || 'Arial'
    )
    const [saving, setSaving] = useState(false)
    const [btnText, setBtnText] = useState('Continue')

    useEffect(() => {
        const loadLocalFonts = async () => {
            if ('queryLocalFonts' in window) {
                try {
                    const localFonts = await window.queryLocalFonts()
                    const uniqueFamilies = new Set()
                    localFonts.forEach((font) => uniqueFamilies.add(font.family))

                    if (uniqueFamilies.size > 0) {
                        const allFonts = Array.from(uniqueFamilies).sort()
                        setFonts(allFonts)
                        if (!allFonts.includes(selectedFont)) {
                            setSelectedFont(allFonts[0])
                        }
                    }
                } catch (err) {
                    console.log('Local font access denied or failed. Using fallback fonts.', err)
                }
            } else {
                console.log('queryLocalFonts API not supported. Using fallback fonts.')
            }
        }

        loadLocalFonts()
    }, [])

    const handleContinue = async () => {
        setSaving(true)
        setBtnText('Saved!')
        setTimeout(() => {
            navigate('/theme')
        }, 500)
    }

    return (
        <div className="font-page">
            <div className="font-container">
                <div className="onboarding-header">
                    <button
                        type="button"
                        className="onboarding-back-btn"
                        onClick={() => navigate('/language')}
                    >
                        {t('Back')}
                    </button>
                    <h2 className="sticky-title">{t('Font Settings')}</h2>
                </div>

                <div className="settings-wrapper">
                    <div className="setting-group">
                        <label htmlFor="fontType">{t('Font Type')}</label>
                        <select
                            id="fontType"
                            className="setting-input"
                            value={selectedFont}
                            onChange={(e) => {
                                const newFont = e.target.value;
                                setSelectedFont(newFont);
                                localStorage.setItem('temp_font', newFont);
                                document.body.style.fontFamily = `"${newFont}", sans-serif`;
                            }}
                        >
                            {fonts.map((font) => (
                                <option
                                    key={font}
                                    value={font}
                                    style={{ fontFamily: `"${font}", sans-serif` }}
                                >
                                    {font}
                                </option>
                            ))}
                        </select>
                        <div className="helper-text">
                            {t('If prompted, allow font access to view all PC fonts.')}
                        </div>
                    </div>

                    <div
                        className="preview-box"
                        style={{ fontFamily: `"${selectedFont}", sans-serif` }}
                    >
                        {t('The quick brown fox jumps over the lazy dog.')}
                    </div>
                </div>

                <button
                    type="button"
                    className="continue-button"
                    disabled={saving}
                    onClick={handleContinue}
                >
                    {t(btnText)}
                </button>
            </div>
        </div>
    )
}

export default FontPage
